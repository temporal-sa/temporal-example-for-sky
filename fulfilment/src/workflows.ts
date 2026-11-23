import {
  allHandlersFinished,
  ApplicationFailure,
  condition,
  continueAsNew,
  getExternalWorkflowHandle,
  log,
  proxyActivities,
  setHandler,
  startChild,
  upsertMemo,
  upsertSearchAttributes,
  workflowInfo,
} from '@temporalio/workflow';
import type { FulfilmentActivities } from './activities.js';
import {
  type ActionName,
  type BundleBehaviour,
  EVENTS,
  type EventName,
  type LineInput,
  type LineStatus,
  type OrderRecord,
  type PlaceOrderRequest,
  type PortfolioLine,
  type PortfolioView,
  PRODUCTS,
  type Release,
  type Route,
  type RouteStep,
  type RowStatus,
  type TimelineEntry,
  lineIdFor,
  lineSummary,
  lineWorkflowId,
  newLineView,
  portfolioWorkflowId,
} from './domain.js';
import {
  ceaseLineSignal,
  changeRouteUpdate,
  lineChangedSignal,
  lineEventSignal,
  lineReleasedSignal,
  placeOrderUpdate,
  releaseLineSignal,
  replaceLineSignal,
} from './messages.js';
import { AccountIdAttribute, RowStatusAttribute } from './search-attributes.js';

// Every downstream call retries 1s, 2s, 4s, 8s, then every 10s, with no attempt limit: giving up
// halfway would leave Portfolio, the provider and billing disagreeing about the customer.
const fulfilment = proxyActivities<FulfilmentActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '10 seconds' },
});

const TIMELINE_LIMIT = 60;

function append(timeline: TimelineEntry[], text: string, tone: TimelineEntry['tone'] = 'info'): void {
  timeline.push({ at: new Date().toISOString(), text, tone });
  if (timeline.length > TIMELINE_LIMIT) timeline.shift();
}

// =================================================================================================
// Portfolio: one per customer. Every order for the customer comes through here, so this is where a
// second order meets the lines the first one is still provisioning.
// =================================================================================================

type PortfolioWork =
  | { kind: 'order'; order: OrderRecord; lines: PortfolioLine[] }
  | { kind: 'release'; to: string; release: Release }
  | { kind: 'cease'; lineId: string; reason: string; replaced: boolean };

const OPEN: LineStatus[] = ['PROVISIONING', 'ACTIVE'];

export async function portfolio(input: { accountId: string; carried?: PortfolioView }): Promise<void> {
  const { accountId } = input;
  const view: PortfolioView = input.carried ?? { accountId, lines: [], orders: [], timeline: [] };
  const work: PortfolioWork[] = [];

  const line = (lineId: string) => view.lines.find((l) => l.lineId === lineId);
  const name = (l: { product: keyof typeof PRODUCTS; lineId: string }) => `${PRODUCTS[l.product].name} (${l.lineId})`;

  function publish(): void {
    upsertMemo({ portfolio: view });
  }

  // Refuses an order that doesn't fit what the customer holds now. It runs before the Update is
  // written to history, so a refused order leaves no trace and the console shows the reason.
  function validateOrder(request: PlaceOrderRequest): void {
    if (view.orders.some((o) => o.orderId === request.orderId)) throw new Error(`order ${request.orderId} was already placed`);
    if (!request.items?.length) throw new Error('an order needs at least one item');
    const touched = new Set<string>();
    let broadbandAdds = 0;
    for (const item of request.items) {
      if (item.type === 'ADD') {
        if (!(item.product in PRODUCTS)) throw new Error(`unknown product ${item.product}`);
        if (PRODUCTS[item.product].broadband) broadbandAdds++;
        if (!item.replaces) {
          const held = view.lines.find(
            (l) => OPEN.includes(l.status) && !l.replacedBy && !l.ceaseRequested &&
              (l.product === item.product || (PRODUCTS[l.product].broadband && PRODUCTS[item.product].broadband)),
          );
          if (held) {
            throw new Error(`the customer already has ${name(held)}${PRODUCTS[item.product].broadband ? '; raise an upgrade on it instead' : ''}`);
          }
          continue;
        }
        const target = line(item.replaces);
        if (!target) throw new Error(`there is no line ${item.replaces} on this account`);
        if (!PRODUCTS[target.product].broadband || !PRODUCTS[item.product].broadband) throw new Error('only a broadband line can be upgraded to another broadband product');
        if (target.product === item.product) throw new Error(`${target.lineId} is already ${PRODUCTS[item.product].name}`);
        if (!request.bundleBehaviour) throw new Error('an upgrade needs a bundle behaviour (REVERT or PROVIDE)');
        assertChangeable(target, touched);
      } else {
        const target = line(item.lineId);
        if (!target) throw new Error(`there is no line ${item.lineId} on this account`);
        assertChangeable(target, touched);
      }
    }
    if (broadbandAdds > 1) throw new Error('an order can add one broadband product');
  }

  function assertChangeable(target: PortfolioLine, touched: Set<string>): void {
    if (touched.has(target.lineId)) throw new Error(`the order changes ${target.lineId} twice`);
    touched.add(target.lineId);
    if (!OPEN.includes(target.status)) throw new Error(`${target.lineId} is ${target.status.toLowerCase()}`);
    if (target.replacedBy) throw new Error(`${target.lineId} is already being replaced by ${target.replacedBy}`);
    if (target.ceaseRequested) throw new Error(`${target.lineId} is already being ceased`);
    if (target.replaces && target.status === 'PROVISIONING') {
      throw new Error(`${target.lineId} is an upgrade still being provisioned; change it once it's active`);
    }
  }

  setHandler(
    placeOrderUpdate,
    (request): PortfolioView => {
      const lines: PortfolioLine[] = [];
      let n = 0;
      for (const item of request.items) {
        if (item.type === 'ADD') {
          const added: PortfolioLine = {
            lineId: lineIdFor(request.orderId, ++n),
            orderId: request.orderId,
            product: item.product,
            status: 'PROVISIONING',
            rowStatus: 'BEGIN',
            replaces: item.replaces,
            billing: {},
          };
          lines.push(added);
          if (item.replaces) line(item.replaces)!.replacedBy = added.lineId;
        } else {
          line(item.lineId)!.ceaseRequested = true;
        }
      }
      const order: OrderRecord = {
        orderId: request.orderId,
        placedAt: new Date().toISOString(),
        items: request.items,
        bundleBehaviour: request.bundleBehaviour,
        lineIds: lines.map((l) => l.lineId),
      };
      view.lines.push(...lines);
      view.orders.push(order);
      const described = request.items.map((item) =>
        item.type === 'CEASE' ? `cease ${item.lineId}` : item.replaces ? `upgrade ${item.replaces} to ${PRODUCTS[item.product].name} (${request.bundleBehaviour})` : `add ${PRODUCTS[item.product].name}`,
      );
      append(view.timeline, `Order ${request.orderId} placed: ${described.join(', ')}`);
      work.push({ kind: 'order', order, lines });
      publish();
      return view;
    },
    { validator: validateOrder },
  );

  setHandler(lineChangedSignal, (summary) => {
    const known = line(summary.lineId);
    if (!known) return;
    const before = known.status;
    // replacedBy is the portfolio's decision; a line only learns it when its Signal arrives.
    Object.assign(known, summary, { replacedBy: summary.replacedBy ?? known.replacedBy });
    if (before !== summary.status) {
      append(view.timeline, `${name(known)} is ${summary.status.toLowerCase()}`);
      // An upgrade of a live line is live now: cease the line it replaces, which stops its billing.
      const replaced = summary.replaces ? line(summary.replaces) : undefined;
      if (summary.status === 'ACTIVE' && replaced?.status === 'ACTIVE') {
        work.push({ kind: 'cease', lineId: replaced.lineId, reason: `replaced by ${summary.lineId}`, replaced: true });
      }
    }
    publish();
  });

  setHandler(lineReleasedSignal, (release) => {
    const replacement = line(release.lineId)?.replacedBy;
    if (!replacement) return;
    append(view.timeline, `${release.lineId} released for ${replacement} (${release.outcome.toLowerCase()})`);
    work.push({ kind: 'release', to: replacement, release });
    publish();
  });

  // Signals a line. A line that has already finished can't be signalled; `orElse` decides what that means.
  async function tell(lineId: string, send: (handle: ReturnType<typeof getExternalWorkflowHandle>) => Promise<void>, orElse: () => void): Promise<void> {
    try {
      await send(getExternalWorkflowHandle(lineWorkflowId(lineId)));
    } catch (err) {
      log.warn('line could not be signalled', { line: lineId, error: String(err) });
      orElse();
    }
  }

  async function carryOut(job: PortfolioWork): Promise<void> {
    switch (job.kind) {
      case 'order': {
        const { order, lines } = job;
        await fulfilment.registerPortfolioChanges({
          accountId,
          orderId: order.orderId,
          lines: lines.map(({ lineId, product, replaces }) => ({ lineId, product, replaces })),
        });
        for (const added of lines) {
          const lineInput: LineInput = { lineId: added.lineId, accountId, orderId: order.orderId, product: added.product, replaces: added.replaces };
          // ABANDON: a line is the customer's product holding and outlives this run of the portfolio,
          // which continues as new from time to time.
          await startChild(productLine, {
            workflowId: lineWorkflowId(added.lineId),
            args: [lineInput],
            parentClosePolicy: 'ABANDON',
            memo: { line: newLineView(lineInput) },
            typedSearchAttributes: [
              { key: AccountIdAttribute, value: accountId },
              { key: RowStatusAttribute, value: 'BEGIN' },
            ],
          });
          if (added.replaces) {
            const replaced = added.replaces;
            await tell(replaced, (h) => h.signal(replaceLineSignal, { byLineId: added.lineId, bundleBehaviour: order.bundleBehaviour as BundleBehaviour }), () =>
              // The old line finished before it heard about the upgrade, so there is nothing to hand over.
              work.push({ kind: 'release', to: added.lineId, release: { lineId: replaced, outcome: 'CANCELLED' } }),
            );
          }
        }
        for (const item of order.items) {
          if (item.type === 'CEASE') {
            await tell(item.lineId, (h) => h.signal(ceaseLineSignal, { reason: `cancelled by order ${order.orderId}` }), () =>
              append(view.timeline, `${item.lineId} had already finished; nothing to cease`),
            );
          }
        }
        return;
      }
      case 'release':
        await tell(job.to, (h) => h.signal(releaseLineSignal, job.release), () => undefined);
        return;
      case 'cease':
        await tell(job.lineId, (h) => h.signal(ceaseLineSignal, { reason: job.reason, replaced: job.replaced }), () => undefined);
        return;
    }
  }

  publish();
  // The portfolio lives as long as the customer. It acts on one piece of work at a time, in the
  // order it arrived, and continues as new when its history gets long.
  for (;;) {
    await condition(() => work.length > 0 || workflowInfo().continueAsNewSuggested);
    if (work.length === 0) {
      await condition(allHandlersFinished);
      if (work.length === 0) await continueAsNew<typeof portfolio>({ accountId, carried: view });
      continue;
    }
    await carryOut(work.shift()!);
    publish();
  }
}

// =================================================================================================
// Product line: one per product the customer holds. It runs the route the product catalogue gave
// it when it started, and stays running while the product is active, until it's ceased.
// =================================================================================================

type Ending =
  | { kind: 'replace'; byLineId: string; bundleBehaviour: BundleBehaviour }
  | { kind: 'cease'; reason: string; replaced: boolean };

export async function productLine(input: LineInput): Promise<LineStatus> {
  const { lineId, accountId, product } = input;
  const view = newLineView(input);
  const portfolioHandle = getExternalWorkflowHandle(portfolioWorkflowId(accountId));

  const received = new Set<EventName>(); // events that have arrived and count
  const undoWaits = new Set<EventName>(); // events an undo is waiting for
  const performed = new Set<string>(); // steps whose action has run
  const refs: Record<string, string> = {}; // each step's reference in the system it called
  let migrateFrom: string | undefined;
  let ending: Ending | undefined;
  let release: Release | undefined;
  let routeChange: { route: Route; compensate: boolean } | undefined;
  let releaseWhileActive = false;
  let lastSummary = '';

  const steps = (): RouteStep[] => view.route?.stages.flatMap((stage) => stage.steps) ?? [];
  const record = (text: string, tone?: TimelineEntry['tone']) => append(view.timeline, text, tone);
  const interrupted = () => ending !== undefined || routeChange !== undefined;

  // Writes the view to the memo, which the console reads with Describe and List.
  function show(): void {
    const awaiting = steps().filter((s) => view.steps[s.id] === 'waiting' && s.waitFor).map((s) => s.waitFor!);
    view.awaiting = [...new Set([...awaiting, ...undoWaits])];
    upsertMemo({ line: view });
    upsertSearchAttributes([{ key: RowStatusAttribute, value: view.rowStatus }]);
  }

  // show(), and tell the portfolio when its summary of this line has changed.
  async function publish(phase?: string): Promise<void> {
    if (phase) view.phase = phase;
    show();
    const summary = lineSummary(view);
    const json = JSON.stringify(summary);
    if (json === lastSummary) return;
    lastSummary = json;
    try {
      await portfolioHandle.signal(lineChangedSignal, summary);
    } catch (err) {
      log.warn('portfolio could not be signalled', { error: String(err) });
    }
  }

  function progress(): string {
    const running = steps().filter((s) => view.steps[s.id] === 'running');
    if (running.length > 0) return `Running: ${running.map((s) => s.name).join(', ')}`;
    const waiting = steps().filter((s) => view.steps[s.id] === 'waiting');
    if (waiting.length > 0) return `Waiting for ${waiting.map((s) => s.waitFor).join(' and ')}`;
    return view.phase;
  }

  // An event counts if a step still to come waits for it, so a callback that arrives early isn't
  // lost. Anything else is logged without a transition, as the scenario's state model says.
  function expects(type: EventName): boolean {
    if (received.has(type)) return false;
    if (undoWaits.has(type)) return true;
    return view.status === 'PROVISIONING' && !ending && steps().some((s) => s.waitFor === type && !['done', 'dropped'].includes(view.steps[s.id]));
  }

  setHandler(lineEventSignal, ({ type }) => {
    if (expects(type)) {
      received.add(type);
      record(`${type} received from ${EVENTS[type]}`);
    } else {
      record(`${type} received in ${view.rowStatus}: no transition, only logged`, 'ignored');
    }
    show();
  });

  // Signals are handled one at a time in the order they arrive. If activation arrives first, the
  // line is live and the upgrade crossgrades it; if the upgrade arrives first, a late activation is
  // only logged. There is no window where both apply.
  setHandler(replaceLineSignal, (request) => {
    if (ending || view.replacedBy || !['PROVISIONING', 'ACTIVE'].includes(view.status)) {
      record(`Replacement by ${request.byLineId} received while ${view.status.toLowerCase()}: ignored`, 'ignored');
      return show();
    }
    view.replacedBy = request.byLineId;
    if (view.status === 'ACTIVE') releaseWhileActive = true;
    else ending = { kind: 'replace', ...request };
    record(`Replaced by ${request.byLineId} (${request.bundleBehaviour})`);
    show();
  });

  setHandler(ceaseLineSignal, ({ reason, replaced }) => {
    if (ending || !['PROVISIONING', 'ACTIVE'].includes(view.status)) {
      record(`Cease (${reason}) received while ${view.status.toLowerCase()}: ignored`, 'ignored');
      return show();
    }
    ending = { kind: 'cease', reason, replaced: replaced ?? false };
    record(`Cease requested: ${reason}`);
    show();
  });

  setHandler(releaseLineSignal, (released) => {
    release = released;
    record(`${released.lineId} released (${released.outcome.toLowerCase()}${released.migrateFrom ? `, migrating ${released.migrateFrom}` : ''})`);
    show();
  });

  // Moves this line onto another version of its route. The handler loads the version, so a
  // missing one fails the Update; the main loop switches over at the line's next gate.
  setHandler(
    changeRouteUpdate,
    async ({ version, compensate }) => {
      const route = await fulfilment.loadRoute(product, version);
      const accepted = steps().find((s) => s.accepted);
      if (accepted && performed.has(accepted.id) && !route.stages.some((stage) => stage.steps.some((s) => s.id === accepted.id))) {
        throw ApplicationFailure.nonRetryable(`v${version} has no step "${accepted.id}", which has already been accepted downstream`);
      }
      if (ending || routeChange) throw ApplicationFailure.nonRetryable('the line changed while the route was loading; try again');
      routeChange = { route, compensate };
      record(`Moving to route v${version} at the next gate${compensate ? ', undoing steps v' + version + ' removes' : ''}`);
      show();
      return { version };
    },
    {
      validator: ({ version }) => {
        if (view.status !== 'PROVISIONING' || ending) throw new Error(`${lineId} is ${view.status.toLowerCase()}; only a line being provisioned can change route`);
        if (!view.route) throw new Error(`${lineId} hasn't loaded its route yet`);
        if (version === view.routeVersion) throw new Error(`${lineId} is already on v${version}`);
        if (routeChange) throw new Error(`${lineId} is already moving to v${routeChange.route.version}`);
      },
    },
  );

  async function setRow(status: RowStatus, reason: string): Promise<void> {
    await fulfilment.setPortfolioRowStatus(lineId, status, reason);
    view.rowStatus = status;
    record(`Portfolio row ${status} (${reason})`);
    await publish();
  }

  // Each route action is an Activity. Undo actions get the reference the forward action returned.
  async function perform(action: ActionName, step: RouteStep, ref?: string): Promise<string> {
    const params = step.params ?? {};
    switch (action) {
      case 'provider.submitVoiceAndData':
        view.providerOrderRef = await fulfilment.submitVoiceAndDataOrder({ lineId, accountId, product, migrateFrom });
        return view.providerOrderRef;
      case 'provider.ceaseVoiceAndData':
        return fulfilment.ceaseVoiceAndDataOrder(ref!);
      case 'logistics.dispatch':
        return fulfilment.dispatchKit({ lineId, stepId: step.id, item: params.item ?? step.name });
      case 'logistics.recall':
        return fulfilment.recallKit(ref!);
      case 'engineer.bookVisit':
        return fulfilment.bookEngineerVisit({ lineId, stepId: step.id, job: params.job ?? step.name });
      case 'engineer.cancelVisit':
        return fulfilment.cancelEngineerVisit(ref!);
      case 'partner.activate':
        return fulfilment.activatePartnerAccount({ lineId, partner: params.partner ?? 'Partner' });
      case 'partner.deactivate':
        return fulfilment.deactivatePartnerAccount(ref!);
    }
  }

  // A step runs its action (if it has one), then waits at its gate (if it has one). An action that
  // has started always finishes, so the line knows what it has to undo; a gate stops waiting as
  // soon as the line is interrupted.
  async function runStep(step: RouteStep): Promise<void> {
    if (view.steps[step.id] === 'pending') {
      if (interrupted()) return;
      if (step.action) {
        view.steps[step.id] = 'running';
        await publish(progress());
        refs[step.id] = await perform(step.action, step);
        performed.add(step.id);
        record(`${step.name}: done (${refs[step.id]})`);
        if (step.accepted) await setRow('AP', step.action === 'provider.submitVoiceAndData' ? 'SUCCESS_SUBMIT_TO_PROVIDER' : 'ORDER_ACCEPTED');
      }
      view.steps[step.id] = step.waitFor ? 'waiting' : 'done';
      await publish(progress());
    }
    if (view.steps[step.id] === 'waiting' && step.waitFor) {
      await condition(() => received.has(step.waitFor!) || interrupted());
      if (!received.has(step.waitFor)) return;
      view.steps[step.id] = 'done';
      record(`${step.name}: gate passed`);
      await publish(progress());
    }
  }

  // Stages run in order and the steps in a stage run together. Returns true once every step is done,
  // false if the line is cancelled or replaced first. A route change restarts from the first stage
  // with work left, skipping what's done.
  async function runRoute(): Promise<boolean> {
    for (;;) {
      for (const stage of view.route!.stages) {
        await Promise.all(stage.steps.map(runStep));
        if (interrupted()) break;
      }
      if (ending) return false;
      if (!routeChange) return true;
      await adoptRoute();
    }
  }

  async function undoStep(step: RouteStep): Promise<void> {
    const undo = step.undo!;
    view.steps[step.id] = 'undoing';
    await publish();
    await perform(undo.action, step, refs[step.id]);
    if (undo.waitFor) {
      undoWaits.add(undo.waitFor);
      await publish(`Waiting for ${undo.waitFor}`);
      await condition(() => received.has(undo.waitFor!));
      undoWaits.delete(undo.waitFor);
    }
    view.steps[step.id] = 'undone';
    record(`${step.name}: undone`);
    await publish();
  }

  // Undoes completed steps, last stage first: a cancellation before activation, or a cease.
  async function undoPerformed(phase: string): Promise<void> {
    for (const step of steps()) {
      if (!performed.has(step.id) && view.steps[step.id] !== 'done') view.steps[step.id] = 'dropped';
      else if (!step.undo && view.steps[step.id] === 'waiting') view.steps[step.id] = 'dropped';
    }
    await publish(phase);
    for (const stage of [...view.route!.stages].reverse()) {
      await Promise.all(stage.steps.filter((s) => performed.has(s.id) && s.undo).map(undoStep));
    }
  }

  // Switches to the new route version: steps both versions share keep their progress, new steps
  // run, and steps the new version drops are undone (compensate) or left as they are.
  async function adoptRoute(): Promise<void> {
    const { route: next, compensate } = routeChange!;
    routeChange = undefined;
    const fromVersion = view.routeVersion!;
    const kept = new Set(next.stages.flatMap((stage) => stage.steps.map((s) => s.id)));
    const removed = steps().filter((s) => !kept.has(s.id));
    const toUndo = compensate ? removed.filter((s) => performed.has(s.id) && s.undo) : [];
    for (const step of removed) {
      if (!toUndo.includes(step) && view.steps[step.id] !== 'done') view.steps[step.id] = 'dropped';
    }
    await Promise.all(toUndo.map(undoStep));
    view.retired.push(...removed.map((s) => ({ id: s.id, name: s.name, fromVersion, state: view.steps[s.id] })));
    for (const step of removed) delete view.steps[step.id];
    view.route = next;
    view.routeVersion = next.version;
    for (const step of steps()) view.steps[step.id] ??= 'pending';
    record(`Moved from route v${fromVersion} to v${next.version}`);
    await publish(progress());
  }

  async function released(outcome: Release['outcome'], ref?: string): Promise<void> {
    try {
      await portfolioHandle.signal(lineReleasedSignal, { lineId, outcome, migrateFrom: ref });
    } catch (err) {
      log.warn('portfolio could not be signalled', { error: String(err) });
    }
  }

  // --- The line's lifecycle ------------------------------------------------------------------------

  // Loaded once and recorded in history: the line keeps this version unless an operator moves it.
  view.route = await fulfilment.loadRoute(product);
  view.routeVersion = view.route.version;
  for (const step of steps()) view.steps[step.id] = 'pending';
  record(`Route ${PRODUCTS[product].name} v${view.routeVersion} loaded from the product catalogue`);
  await publish();

  // An upgrade waits for the line it replaces to let go, and learns whether to migrate its provider order.
  if (input.replaces) {
    await publish(`Held until ${input.replaces} is released`);
    await condition(() => release !== undefined || ending !== undefined);
    migrateFrom = release?.migrateFrom;
  }

  let activated = false;
  if (!ending) {
    await setRow('RQ', input.replaces ? 'CUSTOMER_REQUESTED_CROSSGRADE_RECEIVED' : 'START');
    activated = await runRoute();
  }

  if (!activated) {
    const e = ending!;
    if (e.kind === 'replace' && e.bundleBehaviour === 'PROVIDE' && view.providerOrderRef) {
      // PROVIDE: one migrate order at the provider replaces this one. The row stays AP with a
      // CROSSGRADE cease, as the scenario shows, and nothing is undone.
      for (const step of steps()) if (view.steps[step.id] !== 'done') view.steps[step.id] = 'dropped';
      await fulfilment.logPortfolioRowEvent(lineId, `CEASE (CROSSGRADE): provider order ${view.providerOrderRef} migrates to ${e.byLineId}`);
      view.status = 'MIGRATED';
      record(`Provider order ${view.providerOrderRef} handed to ${e.byLineId}; row stays AP with a CROSSGRADE cease`);
      await publish('Migrated to its replacement');
      await released('MIGRATED', view.providerOrderRef);
    } else {
      // REVERT, or a cancellation: undo what was done, AP -> PAX -> CN.
      const why = e.kind === 'replace' ? `replaced by ${e.byLineId}` : e.reason;
      if (view.rowStatus === 'AP') await setRow('PAX', 'CUSTOMER_REQUESTED_PREACTIVE_CEASE');
      await undoPerformed(`Cancelling: ${why}`);
      await setRow('CN', e.kind === 'replace' ? 'CROSSGRADE_CANCELLED' : 'CUSTOMER_CANCELLED');
      view.status = 'CANCELLED';
      record(`Cancelled before activation (${why})`);
      await publish('Cancelled before activation');
      if (e.kind === 'replace') await released('CANCELLED');
    }
  } else {
    // Activation won any race with an upgrade: the upgrade now crossgrades the live service.
    if (ending?.kind === 'replace') {
      ending = undefined;
      releaseWhileActive = true;
    }
    await publish('Activated: moving the row to AC and starting billing');
    await setRow('AC', 'ACTIVATED');
    // Billing starts only now, so the customer never pays for a line that isn't provisioned.
    await fulfilment.startBilling({ lineId, accountId, product });
    view.billing.since = new Date().toISOString();
    view.status = 'ACTIVE';
    record('Active; billing started');
    await publish('Active and billing');

    // The product holding stays here while it's live, until it's ceased. An upgrade of a live line
    // keeps this one billing until the upgrade activates; then the portfolio ceases it.
    for (;;) {
      await condition(() => releaseWhileActive || ending !== undefined);
      if (!releaseWhileActive) break;
      releaseWhileActive = false;
      await publish(`Active and billing until ${view.replacedBy} activates`);
      await released('ACTIVE', view.providerOrderRef);
    }
    const cease = ending as Extract<Ending, { kind: 'cease' }>;
    await fulfilment.stopBilling(lineId);
    view.billing.until = new Date().toISOString();
    record('Billing stopped');
    if (cease.replaced) {
      await fulfilment.logPortfolioRowEvent(lineId, `CEASE (CROSSGRADE): service migrated to ${view.replacedBy}`);
    } else {
      await undoPerformed(`Ceasing: ${cease.reason}`);
    }
    await setRow('CE', cease.replaced ? 'CROSSGRADE_COMPLETED' : 'CUSTOMER_REQUESTED_CEASE');
    view.status = 'CEASED';
    await publish(cease.replaced ? `Ceased: replaced by ${view.replacedBy}` : 'Ceased');
  }

  await condition(allHandlersFinished);
  return view.status;
}
