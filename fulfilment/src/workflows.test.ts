// Workflow tests against a real Temporal server (the dev server in docker-compose.yml). Every
// downstream system is an in-memory fake, so each test can see exactly which calls fulfilment made.
import { randomBytes } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { WithStartWorkflowOperation, WorkflowUpdateFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FulfilmentActivities } from './activities.js';
import {
  type BundleBehaviour,
  type EventName,
  type LineView,
  type OrderItem,
  type PortfolioView,
  type ProductCode,
  type Route,
  type RowStatus,
  lineWorkflowId,
  portfolioWorkflowId,
} from './domain.js';
import { changeRouteUpdate, lineEventSignal, placeOrderUpdate } from './messages.js';
import type { portfolio } from './workflows.js';

const taskQueue = `test-${randomBytes(4).toString('hex')}`;

// --- The routes the catalogue serves (the same shape as the demo's seed routes) ---------------------

const providerOrder = { id: 'provider-order', name: 'Provider order', action: 'provider.submitVoiceAndData', accepted: true, undo: { action: 'provider.ceaseVoiceAndData', waitFor: 'CANCEL_ORDER_COMPLETED' } } as const;
const hub = { id: 'hub', name: 'Send hub', action: 'logistics.dispatch', waitFor: 'KIT_DELIVERED', undo: { action: 'logistics.recall' } } as const;
const install = { id: 'install', name: 'Install visit', action: 'engineer.bookVisit', waitFor: 'ENGINEER_VISIT_COMPLETED', undo: { action: 'engineer.cancelVisit' } } as const;

const catalogue: Route[] = [
  {
    product: 'BROADBAND_SUPERFAST',
    version: 1,
    description: 'test',
    stages: [
      { name: 'Provision', steps: [providerOrder, hub] },
      { name: 'Activate', steps: [{ id: 'activation', name: 'Activation', waitFor: 'VOICE_AND_DATA_ORDER_COMPLETED' }] },
    ],
  },
  {
    product: 'BB_FIBRE_UNLIMITED_PRO',
    version: 1,
    description: 'test',
    stages: [
      { name: 'Provision', steps: [providerOrder, hub, install] },
      { name: 'Activate', steps: [{ id: 'activation', name: 'Activation', waitFor: 'DATA_ACTIVATED' }] },
    ],
  },
  {
    product: 'SKY_TV',
    version: 1,
    description: 'test',
    stages: [{ name: 'Deliver', steps: [{ id: 'box', name: 'Send box', action: 'logistics.dispatch', accepted: true, waitFor: 'BOX_DELIVERED', undo: { action: 'logistics.recall' } }] }],
  },
  {
    product: 'NETFLIX',
    version: 1,
    description: 'test',
    stages: [{ name: 'Activate', steps: [{ id: 'partner-account', name: 'Netflix account', action: 'partner.activate', params: { partner: 'Netflix' }, accepted: true, waitFor: 'PARTNER_ACTIVATION_ACKNOWLEDGED', undo: { action: 'partner.deactivate' } }] }],
  },
];

// --- In-memory downstream systems -----------------------------------------------------------------

const rowMoves = new Map<string, RowStatus[]>();
const rowEvents = new Map<string, string[]>();
const submissions = new Map<string, { ref: string; migrateFrom?: string }>();
const calls: string[] = [];
const billing = new Map<string, 'BILLING' | 'STOPPED'>();
// Lines whose provider submission fails this many more times, as if the provider were down.
const submitFailures = new Map<string, number>();

const fakeActivities: FulfilmentActivities = {
  async loadRoute(product: ProductCode, version?: number) {
    const versions = catalogue.filter((r) => r.product === product);
    const route = version === undefined ? versions.at(-1) : versions.find((r) => r.version === version);
    if (!route) throw ApplicationFailure.nonRetryable(`no route ${product} v${version}`, 'CatalogueRejected');
    return structuredClone(route);
  },
  async registerPortfolioChanges({ lines }) {
    for (const line of lines) rowMoves.set(line.lineId, rowMoves.get(line.lineId) ?? []);
  },
  async setPortfolioRowStatus(lineId, status) {
    if (rowMoves.get(lineId)!.at(-1) !== status) rowMoves.get(lineId)!.push(status);
  },
  async logPortfolioRowEvent(lineId, note) {
    rowEvents.set(lineId, [...(rowEvents.get(lineId) ?? []), note]);
  },
  async submitVoiceAndDataOrder({ lineId, migrateFrom }) {
    const failuresLeft = submitFailures.get(lineId) ?? 0;
    if (failuresLeft > 0) {
      submitFailures.set(lineId, failuresLeft - 1);
      throw ApplicationFailure.retryable('provider unavailable (test)', 'ProviderUnavailable');
    }
    submissions.set(lineId, { ref: `SNS-${lineId}`, migrateFrom });
    return `SNS-${lineId}`;
  },
  async ceaseVoiceAndDataOrder(ref) {
    calls.push(`cease ${ref}`);
    return ref;
  },
  async dispatchKit({ lineId, stepId }) {
    calls.push(`dispatch ${lineId}/${stepId}`);
    return `CON-${lineId}/${stepId}`;
  },
  async recallKit(ref) {
    calls.push(`recall ${ref}`);
    return ref;
  },
  async bookEngineerVisit({ lineId, stepId }) {
    calls.push(`book ${lineId}/${stepId}`);
    return `VIS-${lineId}/${stepId}`;
  },
  async cancelEngineerVisit(ref) {
    calls.push(`cancel ${ref}`);
    return ref;
  },
  async activatePartnerAccount({ lineId }) {
    calls.push(`partner ${lineId}`);
    return `NFX-${lineId}`;
  },
  async deactivatePartnerAccount(ref) {
    calls.push(`deactivate ${ref}`);
    return ref;
  },
  async startBilling({ lineId }) {
    billing.set(lineId, 'BILLING');
  },
  async stopBilling(lineId) {
    billing.set(lineId, 'STOPPED');
  },
};

// --- Harness ----------------------------------------------------------------------------------------

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createFromExistingServer({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
    activities: fakeActivities,
  });
  running = worker.run();
});

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

const digits = (n: number) => [...randomBytes(n)].map((b) => (b % 10).toString()).join('');
const newAccount = () => `ACC-${digits(6)}`;
const newOrder = () => `ORD-${digits(6)}`;

async function order(accountId: string, items: OrderItem[], bundleBehaviour?: BundleBehaviour): Promise<{ orderId: string; view: PortfolioView }> {
  const orderId = newOrder();
  const view = await env.client.workflow.executeUpdateWithStart(placeOrderUpdate, {
    args: [{ orderId, items, bundleBehaviour }],
    updateId: orderId,
    startWorkflowOperation: new WithStartWorkflowOperation<typeof portfolio>('portfolio', {
      workflowId: portfolioWorkflowId(accountId),
      taskQueue,
      args: [{ accountId }],
      workflowIdConflictPolicy: 'USE_EXISTING',
    }),
  });
  return { orderId, view };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(WorkflowUpdateFailedError);
  return (err as WorkflowUpdateFailedError).cause?.message ?? '';
}

async function line(lineId: string): Promise<LineView | undefined> {
  try {
    return (await env.client.workflow.getHandle(lineWorkflowId(lineId)).describe()).memo?.line as LineView | undefined;
  } catch {
    return undefined; // not started yet
  }
}

// Polls the line's memo until the check passes; the memo is what the console reads.
async function until(lineId: string, check: (view: LineView) => boolean, what: string): Promise<LineView> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const view = await line(lineId);
    if (view && check(view)) return view;
    if (Date.now() > deadline) throw new Error(`${lineId} never became ${what}; last seen: ${JSON.stringify(view && { status: view.status, row: view.rowStatus, phase: view.phase, steps: view.steps })}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const waitingFor = (event: EventName) => (view: LineView) => view.awaiting.includes(event);

async function send(lineId: string, ...events: EventName[]): Promise<void> {
  for (const type of events) await env.client.workflow.getHandle(lineWorkflowId(lineId)).signal(lineEventSignal, { type });
}

async function activeSuperfast(accountId: string): Promise<string> {
  const { orderId } = await order(accountId, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }]);
  const lineId = `${orderId}-1`;
  await until(lineId, waitingFor('KIT_DELIVERED'), 'waiting for its hub');
  await send(lineId, 'KIT_DELIVERED', 'VOICE_AND_DATA_ORDER_COMPLETED');
  await until(lineId, (v) => v.status === 'ACTIVE', 'active');
  return lineId;
}

async function finishFibrePro(lineId: string): Promise<LineView> {
  await until(lineId, (v) => v.rowStatus === 'AP', 'AP');
  await send(lineId, 'KIT_DELIVERED', 'ENGINEER_VISIT_COMPLETED', 'DATA_ACTIVATED');
  return until(lineId, (v) => v.status === 'ACTIVE', 'active');
}

// --- Tests --------------------------------------------------------------------------------------------

describe('a multi-product order', () => {
  it('runs each product line on its own route and bills each one only once it is active', async () => {
    const accountId = newAccount();
    const { view } = await order(accountId, [
      { type: 'ADD', product: 'BROADBAND_SUPERFAST' },
      { type: 'ADD', product: 'SKY_TV' },
      { type: 'ADD', product: 'NETFLIX' },
    ]);
    expect(view.lines.map((l) => l.product)).toEqual(['BROADBAND_SUPERFAST', 'SKY_TV', 'NETFLIX']);
    const [broadband, tv, netflix] = view.lines.map((l) => l.lineId);

    // The provider order and the hub run in parallel; both gates must pass before activation.
    const waiting = await until(broadband, waitingFor('KIT_DELIVERED'), 'waiting for its hub');
    expect(waiting.rowStatus).toBe('AP');
    expect(waiting.routeVersion).toBe(1);

    // Activation arrives before the hub: it's kept, and counts once the hub is delivered.
    await send(broadband, 'VOICE_AND_DATA_ORDER_COMPLETED');
    await send(tv, 'BOX_DELIVERED');
    await send(netflix, 'PARTNER_ACTIVATION_ACKNOWLEDGED');
    await until(tv, (v) => v.status === 'ACTIVE', 'active');
    await until(netflix, (v) => v.status === 'ACTIVE', 'active');
    expect((await line(broadband))!.status).toBe('PROVISIONING');
    expect(billing.has(broadband)).toBe(false);

    await send(broadband, 'KIT_DELIVERED');
    await until(broadband, (v) => v.status === 'ACTIVE', 'active');
    expect(rowMoves.get(broadband)).toEqual(['RQ', 'AP', 'AC']);
    for (const id of [broadband, tv, netflix]) expect(billing.get(id)).toBe('BILLING');
  });
});

describe('an upgrade before activation', () => {
  it('REVERT: undoes the original line (AP -> PAX -> CN), then provisions the upgrade', async () => {
    const accountId = newAccount();
    const { orderId } = await order(accountId, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }]);
    const original = `${orderId}-1`;
    await until(original, waitingFor('KIT_DELIVERED'), 'waiting for its hub');

    const upgrade = `${(await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'REVERT')).orderId}-1`;
    const held = await until(upgrade, (v) => v.phase.startsWith('Held'), 'held');
    expect(held.rowStatus).toBe('BEGIN');

    await until(original, waitingFor('CANCEL_ORDER_COMPLETED'), 'waiting for the provider to confirm the cease');
    expect(calls).toContain(`cease SNS-${original}`);
    expect(calls).toContain(`recall CON-${original}/hub`);
    expect(submissions.has(upgrade)).toBe(false); // nothing goes to the provider while the old order is live

    await send(original, 'CANCEL_ORDER_COMPLETED');
    const cancelled = await until(original, (v) => v.status === 'CANCELLED', 'cancelled');
    expect(rowMoves.get(original)).toEqual(['RQ', 'AP', 'PAX', 'CN']);
    expect(cancelled.steps).toMatchObject({ 'provider-order': 'undone', hub: 'undone', activation: 'dropped' });

    await finishFibrePro(upgrade);
    expect(submissions.get(upgrade)?.migrateFrom).toBeUndefined();
    expect(billing.has(original)).toBe(false);
    expect(billing.get(upgrade)).toBe('BILLING');
  });

  it('PROVIDE: hands the original provider order to the upgrade as one migrate order', async () => {
    const accountId = newAccount();
    const { orderId } = await order(accountId, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }]);
    const original = `${orderId}-1`;
    await until(original, (v) => v.rowStatus === 'AP', 'AP');

    const upgrade = `${(await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'PROVIDE')).orderId}-1`;
    await until(original, (v) => v.status === 'MIGRATED', 'migrated');
    expect(rowMoves.get(original)).toEqual(['RQ', 'AP']);
    expect(rowEvents.get(original)?.[0]).toContain('CROSSGRADE');

    await finishFibrePro(upgrade);
    expect(submissions.get(upgrade)?.migrateFrom).toBe(`SNS-${original}`);
  });

  it('waits for an original whose provider submission is still retrying', async () => {
    const accountId = newAccount();
    const orderId = newOrder();
    submitFailures.set(`${orderId}-1`, 3);
    // Placed with a known order ID so the failures are set before the line runs.
    await env.client.workflow.executeUpdateWithStart(placeOrderUpdate, {
      args: [{ orderId, items: [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }] }],
      updateId: orderId,
      startWorkflowOperation: new WithStartWorkflowOperation<typeof portfolio>('portfolio', {
        workflowId: portfolioWorkflowId(accountId),
        taskQueue,
        args: [{ accountId }],
        workflowIdConflictPolicy: 'USE_EXISTING',
      }),
    });
    const original = `${orderId}-1`;
    await until(original, (v) => v.steps['provider-order'] === 'running', 'submitting to the provider');
    const upgrade = `${(await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'REVERT')).orderId}-1`;

    // The submission finishes first, so the line knows there is a provider order to cease.
    await until(original, waitingFor('CANCEL_ORDER_COMPLETED'), 'waiting for the provider to confirm the cease');
    expect(submitFailures.get(original)).toBe(0);
    await send(original, 'CANCEL_ORDER_COMPLETED');
    await finishFibrePro(upgrade);
  });
});

describe('the race between activation and an upgrade', () => {
  it('activation first: the upgrade crossgrades the live line, which bills until the upgrade is live', async () => {
    const accountId = newAccount();
    const original = await activeSuperfast(accountId);

    const upgrade = `${(await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'REVERT')).orderId}-1`;
    await until(upgrade, (v) => v.rowStatus === 'AP', 'AP');
    expect(submissions.get(upgrade)?.migrateFrom).toBe(`SNS-${original}`);
    expect((await line(original))!.status).toBe('ACTIVE');
    expect(billing.get(original)).toBe('BILLING');

    await finishFibrePro(upgrade);
    const ceased = await until(original, (v) => v.status === 'CEASED', 'ceased');
    expect(billing.get(original)).toBe('STOPPED');
    expect(ceased.rowStatus).toBe('CE');
    expect(calls).not.toContain(`cease SNS-${original}`); // migrated, not given up
  });

  it('upgrade first: a late activation is logged without a transition', async () => {
    const accountId = newAccount();
    const { orderId } = await order(accountId, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }]);
    const original = `${orderId}-1`;
    await until(original, waitingFor('KIT_DELIVERED'), 'waiting for its hub');
    await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'REVERT');
    await until(original, (v) => v.rowStatus === 'PAX', 'PAX');

    await send(original, 'VOICE_AND_DATA_ORDER_COMPLETED');
    const view = await until(original, (v) => v.timeline.some((e) => e.tone === 'ignored'), 'logged');
    expect(view.timeline.find((e) => e.tone === 'ignored')!.text).toBe('VOICE_AND_DATA_ORDER_COMPLETED received in PAX: no transition, only logged');
    expect(view.status).toBe('PROVISIONING');
  });
});

describe('partial cancellation', () => {
  it('cancels one line of an order and leaves the others running', async () => {
    const accountId = newAccount();
    const { view } = await order(accountId, [
      { type: 'ADD', product: 'BROADBAND_SUPERFAST' },
      { type: 'ADD', product: 'NETFLIX' },
    ]);
    const [broadband, netflix] = view.lines.map((l) => l.lineId);
    await until(netflix, waitingFor('PARTNER_ACTIVATION_ACKNOWLEDGED'), 'waiting for Netflix');

    await order(accountId, [{ type: 'CEASE', lineId: netflix }]);
    await until(netflix, (v) => v.status === 'CANCELLED', 'cancelled');
    expect(calls).toContain(`deactivate NFX-${netflix}`);
    expect(rowMoves.get(netflix)).toEqual(['RQ', 'AP', 'PAX', 'CN']);

    await send(broadband, 'KIT_DELIVERED', 'VOICE_AND_DATA_ORDER_COMPLETED');
    await until(broadband, (v) => v.status === 'ACTIVE', 'active');
  });
});

describe('the portfolio refuses orders that conflict with what the customer holds', () => {
  it('refuses a second upgrade, a second broadband line, and a cease of an unknown line', async () => {
    const accountId = newAccount();
    const { orderId } = await order(accountId, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }]);
    const original = `${orderId}-1`;
    expect(await refusal(order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO' }]))).toContain('raise an upgrade on it instead');
    await order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'PROVIDE');
    expect(await refusal(order(accountId, [{ type: 'ADD', product: 'BB_FIBRE_UNLIMITED_PRO', replaces: original }], 'REVERT'))).toContain('already being replaced');
    expect(await refusal(order(accountId, [{ type: 'CEASE', lineId: `${newOrder()}-1` }]))).toContain('no line');
  });
});

describe('route versions', () => {
  it('keeps running lines on their version, and moves one to a new version when asked', async () => {
    // v2 of Superfast: the engineer brings the hub, so the hub step goes and an install visit comes in.
    const v2: Route = {
      product: 'BROADBAND_SUPERFAST',
      version: 2,
      description: 'test v2',
      stages: [
        { name: 'Provision', steps: [providerOrder, install] },
        { name: 'Activate', steps: [{ id: 'activation', name: 'Activation', waitFor: 'VOICE_AND_DATA_ORDER_COMPLETED' }] },
      ],
    };
    const pinnedAccount = newAccount();
    const movedAccount = newAccount();
    const keptAccount = newAccount();
    const pinned = `${(await order(pinnedAccount, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }])).orderId}-1`;
    const moved = `${(await order(movedAccount, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }])).orderId}-1`;
    await until(pinned, waitingFor('KIT_DELIVERED'), 'waiting for its hub');
    const kept = `${(await order(keptAccount, [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }])).orderId}-1`;
    await until(moved, waitingFor('KIT_DELIVERED'), 'waiting for its hub');
    await until(kept, waitingFor('KIT_DELIVERED'), 'waiting for its hub');

    catalogue.push(v2);
    try {
      const fresh = `${(await order(newAccount(), [{ type: 'ADD', product: 'BROADBAND_SUPERFAST' }])).orderId}-1`;
      expect((await until(fresh, (v) => v.routeVersion !== undefined, 'routed')).routeVersion).toBe(2);
      expect((await line(pinned))!.routeVersion).toBe(1);

      await env.client.workflow.getHandle(lineWorkflowId(moved)).executeUpdate(changeRouteUpdate, { args: [{ version: 2, compensate: true }] });
      const after = await until(moved, waitingFor('ENGINEER_VISIT_COMPLETED'), 'waiting for the install visit');
      expect(after.routeVersion).toBe(2);
      expect(after.retired).toEqual([{ id: 'hub', name: 'Send hub', fromVersion: 1, state: 'undone' }]);
      expect(after.steps['provider-order']).toBe('done'); // kept its progress
      expect(calls).toContain(`recall CON-${moved}/hub`);
      expect(submissions.has(moved)).toBe(true);

      await send(moved, 'ENGINEER_VISIT_COMPLETED', 'VOICE_AND_DATA_ORDER_COMPLETED');
      await until(moved, (v) => v.status === 'ACTIVE', 'active');

      // Without compensation, the hub already sent stays with the customer; the line stops waiting for it.
      await env.client.workflow.getHandle(lineWorkflowId(kept)).executeUpdate(changeRouteUpdate, { args: [{ version: 2, compensate: false }] });
      const keptAfter = await until(kept, waitingFor('ENGINEER_VISIT_COMPLETED'), 'waiting for the install visit');
      expect(keptAfter.retired).toEqual([{ id: 'hub', name: 'Send hub', fromVersion: 1, state: 'dropped' }]);
      expect(calls).not.toContain(`recall CON-${kept}/hub`);

      const sameVersion = await refusal(env.client.workflow.getHandle(lineWorkflowId(pinned)).executeUpdate(changeRouteUpdate, { args: [{ version: 1, compensate: false }] }));
      expect(sameVersion).toContain('already on v1');
    } finally {
      catalogue.splice(catalogue.indexOf(v2), 1);
    }
  });
});
