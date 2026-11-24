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
  type CeaseInput,
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
  type UndoPlan,
  type UndoStep,
  ceaseWorkflowId,
  lineIdFor,
  lineSummary,
  lineWorkflowId,
  newCeaseView,
  newLineView,
  portfolioWorkflowId,
} from './domain.js';
import {
  cancelLineSignal,
  changeRouteUpdate,
  historyQuery,
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

// Each Workflow keeps its own history and serves it to the console through the `history` Query.
// It stays out of the memo, so a memo write doesn't copy the whole history into the Event History.
function journal(carried: TimelineEntry[] = []) {
  const timeline = [...carried];
  setHandler(historyQuery, () => timeline);
  return {
    timeline,
    record(text: string, tone: TimelineEntry['tone'] = 'info'): void {
      timeline.push({ at: new Date().toISOString(), text, tone });
      if (timeline.length > TIMELINE_LIMIT) timeline.shift();
    },
  };
}

// The undo half of each route action, shared by a line cancelled before activation and a cease.
function undoAction(action: ActionName, ref: string): Promise<string> {
  switch (action) {
    case 'provider.ceaseVoiceAndData':
      return fulfilment.ceaseVoiceAndDataOrder(ref);
    case 'logistics.recall':
      return fulfilment.recallKit(ref);
    case 'engineer.cancelVisit':
      return fulfilment.cancelEngineerVisit(ref);
    case 'partner.deactivate':
      return fulfilment.deactivatePartnerAccount(ref);
    default:
      throw ApplicationFailure.nonRetryable(`${action} doesn't undo anything`);
  }
}

// =================================================================================================
// Portfolio: one per customer, for as long as they're a customer. Every order comes through here, so
// this is where a second order meets the lines the first one is still provisioning. It's the only
// long-lived Workflow: lines and ceases are bounded runs it starts, and it continues as new when its
// history gets long.
// =================================================================================================

type PortfolioWork =
  | { kind: 'order'; order: OrderRecord; lines: PortfolioLine[] }
  | { kind: 'release'; to: string; release: Release }
  | { kind: 'cease'; lineId: string; reason: string; replacedBy?: string };

const OPEN: LineStatus[] = ['PROVISIONING', 'ACTIVE'];

interface PortfolioCarried {
  view: PortfolioView;
  timeline: TimelineEntry[];
}

export async function portfolio(input: { accountId: string; carried?: PortfolioCarried }): Promise<void> {
  const { accountId } = input;
  const view: PortfolioView = input.carried?.view ?? { accountId, lines: [], orders: [], rev: 0 };
  const { timeline, record } = journal(input.carried?.timeline);
  const work: PortfolioWork[] = [];

  const line = (lineId: string) => view.lines.find((l) => l.lineId === lineId);
  const name = (l: { product: keyof typeof PRODUCTS; lineId: string }) => `${PRODUCTS[l.product].name} (${l.lineId})`;

  // The memo is what the console lists customers from, through List and Describe.
  function publish(): void {
    view.rev++;
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
    if (target.ceaseRequested || target.ceaseStarted) throw new Error(`${target.lineId} is already being ceased`);
    if (target.replaces && target.status === 'PROVISIONING') {
      throw new Error(`${target.lineId} is an upgrade still being provisioned; change it once it's active`);
    }
  }

  // The portfolio decides what happens to a line once it's live, from what it knows about every
  // line. These two run whenever that knowledge changes, and each acts at most once per line.

  // A line being replaced that activated first: the replacement crossgrades the live service.
  function releaseIfDue(old: PortfolioLine): void {
    if (old.status !== 'ACTIVE' || !old.replacedBy || old.released) return;
    old.released = true;
    record(`${name(old)} is live, so ${old.replacedBy} crossgrades it`);
    work.push({ kind: 'release', to: old.replacedBy, release: { lineId: old.lineId, outcome: 'ACTIVE', migrateFrom: old.providerOrderRef } });
  }

  // A live line the customer ceased, or whose replacement is now live: start a ceaseLine Workflow.
  function ceaseIfDue(target: PortfolioLine | undefined): void {
    if (!target || target.status !== 'ACTIVE' || target.ceaseStarted) return;
    const replacement = target.replacedBy ? line(target.replacedBy) : undefined;
    if (target.ceaseRequested) {
      work.push({ kind: 'cease', lineId: target.lineId, reason: 'the customer ordered a cease' });
    } else if (replacement?.status === 'ACTIVE') {
      work.push({ kind: 'cease', lineId: target.lineId, reason: `replaced by ${replacement.lineId}`, replacedBy: replacement.lineId });
    } else {
      return;
    }
    target.ceaseStarted = true;
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
      record(`Order ${request.orderId} placed: ${described.join(', ')}`);
      work.push({ kind: 'order', order, lines });
      // Queued after the order, so a replacement exists before it's released.
      for (const item of request.items) {
        if (item.type === 'ADD' && item.replaces) releaseIfDue(line(item.replaces)!);
        if (item.type === 'CEASE') ceaseIfDue(line(item.lineId));
      }
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
    if (before !== known.status) record(`${name(known)} is ${known.status.toLowerCase()}`);
    releaseIfDue(known);
    ceaseIfDue(known);
    if (known.replaces) ceaseIfDue(line(known.replaces));
    publish();
  });

  setHandler(lineReleasedSignal, (release) => {
    const old = line(release.lineId);
    if (!old?.replacedBy || old.released) return;
    old.released = true;
    record(`${release.lineId} released for ${old.replacedBy} (${release.outcome.toLowerCase()})`);
    work.push({ kind: 'release', to: old.replacedBy, release });
    publish();
  });

  // Signals a line that's still provisioning. One that has just finished can't be signalled; that's
  // fine, because its last report reaches the portfolio first and the portfolio acts on that.
  async function tell(lineId: string, send: (handle: ReturnType<typeof getExternalWorkflowHandle>) => Promise<void>): Promise<void> {
    try {
      await send(getExternalWorkflowHandle(lineWorkflowId(lineId)));
    } catch (err) {
      log.info('line had already finished', { line: lineId, error: String(err) });
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
          // ABANDON: the line runs until it's active or cancelled, which can outlast this run of the
          // portfolio when it continues as new.
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
          const old = added.replaces ? line(added.replaces)! : undefined;
          if (old?.status === 'PROVISIONING') {
            await tell(old.lineId, (h) => h.signal(replaceLineSignal, { byLineId: added.lineId, bundleBehaviour: order.bundleBehaviour as BundleBehaviour }));
          }
        }
        for (const item of order.items) {
          if (item.type === 'CEASE' && line(item.lineId)?.status === 'PROVISIONING') {
            await tell(item.lineId, (h) => h.signal(cancelLineSignal, { reason: `cancelled by order ${order.orderId}` }));
          }
        }
        return;
      }
      case 'release':
        await tell(job.to, (h) => h.signal(releaseLineSignal, job.release));
        return;
      case 'cease': {
        const target = line(job.lineId)!;
        const ceaseInput: CeaseInput = { line: { ...lineSummary(target), accountId }, reason: job.reason, replacedBy: job.replacedBy };
        await startChild(ceaseLine, {
          workflowId: ceaseWorkflowId(job.lineId),
          args: [ceaseInput],
          parentClosePolicy: 'ABANDON',
          memo: { cease: newCeaseView(ceaseInput) },
          typedSearchAttributes: [
            { key: AccountIdAttribute, value: accountId },
            { key: RowStatusAttribute, value: target.rowStatus },
          ],
        });
        record(`Ceasing ${name(target)}: ${job.reason}`);
        return;
      }
    }
  }

  publish();
  // One piece of work at a time, in the order it arrived. Continues as new when the history gets
  // long, once no handler is running and nothing is queued.
  for (;;) {
    await condition(() => work.length > 0 || workflowInfo().continueAsNewSuggested);
    if (work.length === 0) {
      await condition(allHandlersFinished);
      if (work.length === 0) await continueAsNew<typeof portfolio>({ accountId, carried: { view, timeline } });
      continue;
    }
    await carryOut(work.shift()!);
    publish();
  }
}

// =================================================================================================
// Product line: one per product on an order. It runs the route the product catalogue gave it when it
// started, and ends when the line is active (AC), cancelled (CN) or migrated to its replacement. So
// it runs for days or weeks, not for as long as the customer keeps the product.
// =================================================================================================

type Ending = { kind: 'replace'; byLineId: string; bundleBehaviour: BundleBehaviour } | { kind: 'cancel'; reason: string };

export async function productLine(input: LineInput): Promise<LineStatus> {
  const { lineId, accountId, product } = input;
  const view = newLineView(input);
  const { record } = journal();
  const portfolioHandle = getExternalWorkflowHandle(portfolioWorkflowId(accountId));

  let route: Route | undefined;
  const received = new Set<EventName>(); // events that have arrived and count
  const undoWaits = new Set<EventName>(); // events an undo is waiting for
  const performed = new Set<string>(); // steps whose action has run
  const refs: Record<string, string> = {}; // each step's reference in the system it called
  let migrateFrom: string | undefined;
  let ending: Ending | undefined;
  let activated = false;
  let release: Release | undefined;
  let routeChange: { route: Route; compensate: boolean } | undefined;
  let lastSummary = '';

  const steps = (): RouteStep[] => route?.stages.flatMap((stage) => stage.steps) ?? [];
  const interrupted = () => ending !== undefined || routeChange !== undefined;

  // Writes the view to the memo, which the console reads with Describe and List.
  function show(): void {
    const awaiting = steps().filter((s) => view.steps[s.id] === 'waiting' && s.waitFor).map((s) => s.waitFor!);
    view.awaiting = [...new Set([...awaiting, ...undoWaits])];
    view.rev++;
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
    return !ending && steps().some((s) => s.waitFor === type && !['done', 'dropped'].includes(view.steps[s.id]));
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

  // Signals are handled one at a time in the order they arrive. If the upgrade arrives first, the
  // line is cancelled or migrated and a late activation is only logged. If activation arrives first,
  // the line activates and the portfolio, which hears of it, crossgrades the live line instead.
  setHandler(replaceLineSignal, (request) => {
    view.replacedBy = request.byLineId;
    if (activated || ending) {
      record(`Replacement by ${request.byLineId} arrived after activation: the portfolio crossgrades the live line`);
    } else {
      ending = { kind: 'replace', ...request };
      record(`Replaced by ${request.byLineId} (${request.bundleBehaviour})`);
    }
    show();
  });

  setHandler(cancelLineSignal, ({ reason }) => {
    if (activated || ending) {
      record(`Cancellation (${reason}) arrived after activation: the portfolio ceases the live line`);
    } else {
      ending = { kind: 'cancel', reason };
      record(`Cancellation requested: ${reason}`);
    }
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
      const next = await fulfilment.loadRoute(product, version);
      const accepted = steps().find((s) => s.accepted);
      if (accepted && performed.has(accepted.id) && !next.stages.some((stage) => stage.steps.some((s) => s.id === accepted.id))) {
        throw ApplicationFailure.nonRetryable(`v${version} has no step "${accepted.id}", which has already been accepted downstream`);
      }
      if (ending || routeChange || activated) throw ApplicationFailure.nonRetryable('the line changed while the route was loading; try again');
      routeChange = { route: next, compensate };
      record(`Moving to route v${version} at the next gate${compensate ? ', undoing steps v' + version + ' removes' : ''}`);
      show();
      return { version };
    },
    {
      validator: ({ version }) => {
        if (activated || ending) throw new Error(`${lineId} is ${activated ? 'active' : 'being cancelled'}; only a line being provisioned can change route`);
        if (!route) throw new Error(`${lineId} hasn't loaded its route yet`);
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

  // Each forward route action is an Activity.
  async function perform(action: ActionName, step: RouteStep): Promise<string> {
    const params = step.params ?? {};
    switch (action) {
      case 'provider.submitVoiceAndData':
        view.providerOrderRef = await fulfilment.submitVoiceAndDataOrder({ lineId, accountId, product, migrateFrom });
        return view.providerOrderRef;
      case 'logistics.dispatch':
        return fulfilment.dispatchKit({ lineId, stepId: step.id, item: params.item ?? step.name });
      case 'engineer.bookVisit':
        return fulfilment.bookEngineerVisit({ lineId, stepId: step.id, job: params.job ?? step.name });
      case 'partner.activate':
        return fulfilment.activatePartnerAccount({ lineId, partner: params.partner ?? 'Partner' });
      default:
        throw ApplicationFailure.nonRetryable(`${action} isn't a forward action`);
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

  // Stages run in order and the steps in a stage run together. Returns true once every step is done
  // (activated, even if an upgrade or cancellation arrived in the same moment), false if the line is
  // cancelled or replaced first. A route change restarts from the first stage with work left.
  async function runRoute(): Promise<boolean> {
    for (;;) {
      for (const stage of route!.stages) {
        await Promise.all(stage.steps.map(runStep));
        if (interrupted()) break;
      }
      if (steps().every((s) => view.steps[s.id] === 'done')) return true;
      if (ending) return false;
      await adoptRoute();
    }
  }

  async function undoStep(step: RouteStep): Promise<void> {
    const undo = step.undo!;
    view.steps[step.id] = 'undoing';
    await publish();
    await undoAction(undo.action, refs[step.id]);
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

  // Undoes completed steps, last stage first: a cancellation before activation.
  async function undoPerformed(phase: string): Promise<void> {
    for (const step of steps()) {
      if (!performed.has(step.id) && view.steps[step.id] !== 'done') view.steps[step.id] = 'dropped';
      else if (!step.undo && view.steps[step.id] === 'waiting') view.steps[step.id] = 'dropped';
    }
    await publish(phase);
    for (const stage of [...route!.stages].reverse()) {
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
    route = next;
    view.routeVersion = next.version;
    for (const step of steps()) view.steps[step.id] ??= 'pending';
    record(`Moved from route v${fromVersion} to v${next.version}`);
    await publish(progress());
  }

  // What a cease would have to reverse, handed to the portfolio when the line activates.
  function undoPlan(): UndoPlan {
    return route!.stages
      .map((stage) =>
        stage.steps
          .filter((s) => performed.has(s.id) && s.undo)
          .map((s): UndoStep => ({ stepId: s.id, name: s.name, action: s.undo!.action, ref: refs[s.id], waitFor: s.undo!.waitFor })),
      )
      .filter((stage) => stage.length > 0);
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
  route = await fulfilment.loadRoute(product);
  view.routeVersion = route.version;
  for (const step of steps()) view.steps[step.id] = 'pending';
  record(`Route ${PRODUCTS[product].name} v${view.routeVersion} loaded from the product catalogue`);
  await publish();

  // An upgrade waits for the line it replaces to let go, and learns whether to migrate its provider order.
  if (input.replaces) {
    await publish(`Held until ${input.replaces} is released`);
    await condition(() => release !== undefined || ending !== undefined);
    migrateFrom = release?.migrateFrom;
  }

  if (!ending) {
    await setRow('RQ', input.replaces ? 'CUSTOMER_REQUESTED_CROSSGRADE_RECEIVED' : 'START');
    activated = await runRoute();
  }

  if (activated) {
    // An upgrade or cancellation that arrived as the last gate passed is the portfolio's to act on
    // now: it crossgrades or ceases the live line.
    if (ending) record(`${ending.kind === 'replace' ? 'The replacement' : 'The cancellation'} arrived as the last gate passed: the portfolio acts on the live line`);
    ending = undefined;
    await publish('Activated: moving the row to AC and starting billing');
    await setRow('AC', 'ACTIVATED');
    // Billing starts only now, so the customer never pays for a line that isn't provisioned.
    await fulfilment.startBilling({ lineId, accountId, product });
    view.billing.since = new Date().toISOString();
    view.status = 'ACTIVE';
    view.undo = undoPlan();
    record('Active; billing started. Provisioning is done, so this Workflow ends here');
    await publish('Active and billing');
  } else if (ending!.kind === 'replace' && ending!.bundleBehaviour === 'PROVIDE' && view.providerOrderRef) {
    // PROVIDE: one migrate order at the provider replaces this one. The row stays AP with a
    // CROSSGRADE cease, as the scenario shows, and nothing is undone.
    const byLineId = ending!.byLineId;
    for (const step of steps()) if (view.steps[step.id] !== 'done') view.steps[step.id] = 'dropped';
    await fulfilment.logPortfolioRowEvent(lineId, `CEASE (CROSSGRADE): provider order ${view.providerOrderRef} migrates to ${byLineId}`);
    view.status = 'MIGRATED';
    record(`Provider order ${view.providerOrderRef} handed to ${byLineId}; row stays AP with a CROSSGRADE cease`);
    await publish('Migrated to its replacement');
    await released('MIGRATED', view.providerOrderRef);
  } else {
    // REVERT, or a cancellation: undo what was done, AP -> PAX -> CN.
    const e = ending!;
    const why = e.kind === 'replace' ? `replaced by ${e.byLineId}` : e.reason;
    if (view.rowStatus === 'AP') await setRow('PAX', 'CUSTOMER_REQUESTED_PREACTIVE_CEASE');
    await undoPerformed(`Cancelling: ${why}`);
    await setRow('CN', e.kind === 'replace' ? 'CROSSGRADE_CANCELLED' : 'CUSTOMER_CANCELLED');
    view.status = 'CANCELLED';
    record(`Cancelled before activation (${why})`);
    await publish('Cancelled before activation');
    if (e.kind === 'replace') await released('CANCELLED');
  }

  await condition(allHandlersFinished);
  return view.status;
}

// =================================================================================================
// Cease: one per live line the portfolio ceases, because the customer asked or because its
// replacement is live. It stops billing, undoes what the line set up (unless the service migrated to
// the replacement), and moves the row to CE. It runs for as long as the provider takes to confirm.
// =================================================================================================

export async function ceaseLine(input: CeaseInput): Promise<LineStatus> {
  const { line, reason, replacedBy } = input;
  const { lineId, accountId } = line;
  const view = newCeaseView(input);
  const { record } = journal();
  const received = new Set<EventName>();

  function show(phase?: string): void {
    if (phase) view.phase = phase;
    view.rev++;
    upsertMemo({ cease: view });
    upsertSearchAttributes([{ key: RowStatusAttribute, value: view.rowStatus }]);
  }

  async function report(status: LineStatus): Promise<void> {
    const { accountId: _, ...summary } = line;
    try {
      await getExternalWorkflowHandle(portfolioWorkflowId(accountId)).signal(lineChangedSignal, { ...summary, status, rowStatus: view.rowStatus, billing: view.billing });
    } catch (err) {
      log.warn('portfolio could not be signalled', { error: String(err) });
    }
  }

  setHandler(lineEventSignal, ({ type }) => {
    if (view.awaiting.includes(type) && !received.has(type)) {
      received.add(type);
      record(`${type} received from ${EVENTS[type]}`);
    } else {
      record(`${type} received while ceasing: no transition, only logged`, 'ignored');
    }
    show();
  });

  async function undo(step: UndoStep): Promise<void> {
    const state = view.steps.find((s) => s.stepId === step.stepId)!;
    state.state = 'undoing';
    show();
    await undoAction(step.action, step.ref);
    if (step.waitFor) {
      view.awaiting.push(step.waitFor);
      show(`Waiting for ${step.waitFor}`);
      await condition(() => received.has(step.waitFor!));
      view.awaiting = view.awaiting.filter((e) => e !== step.waitFor);
    }
    state.state = 'undone';
    record(`${step.name}: undone`);
    show();
  }

  record(`Ceasing ${lineId}: ${reason}`);
  show('Stopping billing');
  await fulfilment.stopBilling(lineId);
  view.billing = { ...view.billing, until: new Date().toISOString() };
  record('Billing stopped');
  show();
  await report('ACTIVE');

  if (replacedBy) {
    await fulfilment.logPortfolioRowEvent(lineId, `CEASE (CROSSGRADE): service migrated to ${replacedBy}`);
    record(`Service migrated to ${replacedBy}; nothing to undo`);
  } else {
    show('Undoing what the line set up');
    for (const stage of [...(line.undo ?? [])].reverse()) await Promise.all(stage.map(undo));
  }

  await fulfilment.setPortfolioRowStatus(lineId, 'CE', replacedBy ? 'CROSSGRADE_COMPLETED' : 'CUSTOMER_REQUESTED_CEASE');
  view.rowStatus = 'CE';
  view.status = 'CEASED';
  record('Portfolio row CE');
  show(replacedBy ? `Ceased: replaced by ${replacedBy}` : 'Ceased');
  await report('CEASED');

  await condition(allHandlersFinished);
  return 'CEASED';
}
