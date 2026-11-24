// The fulfilment console's API. The console loads from one request (GET /api/console), and each
// action is one request that makes one Temporal call. State comes from the Workflows' memos through
// List and Describe, so the console keeps working while the Worker is down. The only Query is
// `history`, for the detail views, and the API sends it only when a memo's `rev` says the history
// has changed: an open console doesn't Query on every refresh.
import fastifyStatic from '@fastify/static';
import {
  Client,
  Connection,
  WithStartWorkflowOperation,
  WorkflowNotFoundError,
  WorkflowUpdateFailedError,
  type WorkflowExecutionDescription,
} from '@temporalio/client';
import Fastify, { type FastifyReply } from 'fastify';
import { requiredEnv, temporalConfig } from './config.js';
import {
  type BundleBehaviour,
  type CeaseView,
  EVENTS,
  type EventName,
  type LineView,
  type OrderItem,
  type PortfolioView,
  PRODUCTS,
  type ProductCode,
  type Route,
  type TimelineEntry,
  ceaseWorkflowId,
  lineWorkflowId,
  portfolioWorkflowId,
  routeProblems,
} from './domain.js';
import { changeRouteUpdate, historyQuery, lineEventSignal, placeOrderUpdate } from './messages.js';
import { AccountIdAttribute } from './search-attributes.js';
import type { portfolio } from './workflows.js';

const taskQueue = requiredEnv('TEMPORAL_TASK_QUEUE');
const downstreamUrl = requiredEnv('DOWNSTREAM_URL');
const temporalUiUrl = requiredEnv('TEMPORAL_UI_URL');
const consoleDir = process.env.CONSOLE_DIR;
const { connectionOptions, namespace } = temporalConfig();

const connection = await Connection.connect(connectionOptions);
const client = new Client({ connection, namespace });

const ORDER_ID = /^ORD-[0-9A-Z]{6}$/;
const ACCOUNT_ID = /^ACC-[0-9]{6}$/;
const LINE_ID = /^ORD-[0-9A-Z]{6}-[0-9]+$/;
const LIST_LIMIT = 100;
// Scoped to this demo's Task Queue, so other runs on the same server (the tests) aren't listed.
const IN_DEMO = `TaskQueue="${taskQueue}"`;
const PORTFOLIOS_QUERY = `WorkflowType="portfolio" AND ExecutionStatus="Running" AND ${IN_DEMO}`;

function executionUrl(workflowId: string): string {
  return `${temporalUiUrl}/namespaces/${encodeURIComponent(namespace)}/workflows/${encodeURIComponent(workflowId)}`;
}

async function list<T>(query: string, read: (memo: Record<string, unknown> | undefined) => T | undefined): Promise<T[]> {
  const found: T[] = [];
  for await (const execution of client.workflow.list({ query, pageSize: LIST_LIMIT })) {
    const item = read(execution.memo);
    if (item) found.push(item);
    if (found.length >= LIST_LIMIT) break;
  }
  return found;
}

// Retries in progress, read from Describe's pending Activities. This is how the console shows
// "Billing unavailable, Temporal is retrying" without asking the Worker.
function pendingWork(description: WorkflowExecutionDescription) {
  return (description.raw.pendingActivities ?? []).map((activity) => {
    const next = activity.nextAttemptScheduleTime?.seconds;
    return {
      activity: activity.activityType?.name ?? 'unknown',
      attempt: activity.attempt ?? 1,
      lastFailure: activity.lastFailure?.message ?? undefined,
      nextAttemptAt: next != null ? new Date(Number(next) * 1000).toISOString() : undefined,
    };
  });
}

async function describe(workflowId: string) {
  try {
    return await client.workflow.getHandle(workflowId).describe();
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return undefined;
    throw err;
  }
}

// --- History, through the `history` Query --------------------------------------------------------

const HISTORY_CACHE = 500;
const QUERY_DEADLINE_MS = 2_000;
const RETRY_FAILED_QUERY_MS = 30_000;
const histories = new Map<string, { rev: number; timeline?: TimelineEntry[]; failedAt?: number }>();

// A Workflow's history, as of its memo's `rev`. The Query runs only when `rev` has moved on, so it
// costs one Query per change, not one per refresh. A Query needs a Worker: while it's down, this
// returns the last history it got (current: false), or none, and doesn't keep the console waiting.
async function history(workflowId: string, rev: number): Promise<{ entries: TimelineEntry[]; current: boolean } | null> {
  const cached = histories.get(workflowId);
  if (cached?.rev === rev && cached.timeline) return { entries: cached.timeline, current: true };
  if (cached?.failedAt && Date.now() - cached.failedAt < RETRY_FAILED_QUERY_MS) return cached.timeline ? { entries: cached.timeline, current: false } : null;
  try {
    const timeline = await connection.withDeadline(Date.now() + QUERY_DEADLINE_MS, () => client.workflow.getHandle(workflowId).query(historyQuery));
    histories.delete(workflowId);
    histories.set(workflowId, { rev, timeline });
    if (histories.size > HISTORY_CACHE) histories.delete(histories.keys().next().value!);
    return { entries: timeline, current: true };
  } catch {
    histories.set(workflowId, { rev: cached?.rev ?? -1, timeline: cached?.timeline, failedAt: Date.now() });
    return cached?.timeline ? { entries: cached.timeline, current: false } : null;
  }
}

// --- Lines -----------------------------------------------------------------------------------------

// A live line's cease runs in its own Workflow. The console shows one line, so once a cease has
// started, its state (row, billing, what it's waiting for) is the line's state.
function withCease(line: LineView, cease: CeaseView | undefined) {
  if (!cease) return { ...line, cease: null };
  return {
    ...line,
    status: cease.status === 'CEASED' ? ('CEASED' as const) : line.status,
    rowStatus: cease.rowStatus,
    billing: cease.billing,
    phase: cease.phase,
    awaiting: cease.awaiting,
    cease,
  };
}

async function lineDetail(lineId: string) {
  const [lineDescription, ceaseDescription] = await Promise.all([describe(lineWorkflowId(lineId)), describe(ceaseWorkflowId(lineId))]);
  const line = lineDescription?.memo?.line as LineView | undefined;
  if (!lineDescription || !line) return undefined;
  const cease = ceaseDescription?.memo?.cease as CeaseView | undefined;
  const [lineHistory, ceaseHistory] = await Promise.all([
    history(lineWorkflowId(lineId), line.rev),
    cease ? history(ceaseWorkflowId(lineId), cease.rev) : null,
  ]);
  const timeline = [...(lineHistory?.entries ?? []), ...(ceaseHistory?.entries ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  return {
    ...withCease(line, cease),
    timeline,
    historyCurrent: lineHistory?.current === true && (!cease || ceaseHistory?.current === true),
    pendingWork: [...pendingWork(lineDescription), ...(ceaseDescription ? pendingWork(ceaseDescription) : [])],
    temporalUrl: executionUrl(lineWorkflowId(lineId)),
    ceaseTemporalUrl: cease ? executionUrl(ceaseWorkflowId(lineId)) : null,
  };
}

async function customer(accountId: string) {
  const id = portfolioWorkflowId(accountId);
  const [description, executions] = await Promise.all([
    describe(id),
    list(`(WorkflowType="productLine" OR WorkflowType="ceaseLine") AND AccountId="${accountId}" AND ${IN_DEMO}`, (memo) =>
      memo as { line?: LineView; cease?: CeaseView } | undefined,
    ),
  ]);
  const portfolio = description?.memo?.portfolio as PortfolioView | undefined;
  if (!portfolio) return undefined;
  const portfolioHistory = await history(id, portfolio.rev);
  const ceases = new Map(executions.flatMap((e) => (e.cease ? [[e.cease.lineId, e.cease] as const] : [])));
  const known = new Map(portfolio.lines.map((l, index) => [l.lineId, { line: l, index }]));
  return {
    portfolio: { ...portfolio, lines: portfolio.lines.map(({ undo: _undo, ...rest }) => rest) },
    // In the order the portfolio took them on, so a replacement sits after the line it replaces.
    lines: executions
      .flatMap((e) => (e.line ? [e.line] : []))
      .map(({ undo: _undo, ...line }) => {
        const merged = withCease(line, ceases.get(line.lineId));
        // The portfolio decides a replacement; a line that had already finished never heard of it.
        return { ...merged, replacedBy: merged.replacedBy ?? known.get(line.lineId)?.line.replacedBy, cease: merged.cease ? { status: merged.cease.status } : null };
      })
      .sort((a, b) => (known.get(a.lineId)?.index ?? 0) - (known.get(b.lineId)?.index ?? 0)),
    timeline: portfolioHistory?.entries ?? [],
    historyCurrent: portfolioHistory?.current === true,
    pendingWork: pendingWork(description!),
    temporalUrl: executionUrl(id),
  };
}

async function downstream(path: string, init?: RequestInit) {
  const response = await fetch(`${downstreamUrl}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? `downstream ${path}: HTTP ${response.status}`), { statusCode: response.status });
  return body;
}

// An Update refused by a Workflow's validator, or failed by its handler: 409 with the reason.
function refused(err: unknown, reply: FastifyReply) {
  if (err instanceof WorkflowUpdateFailedError) {
    return reply.code(409).send({ error: err.cause?.message ?? err.message });
  }
  if (err instanceof WorkflowNotFoundError) return reply.code(404).send({ error: 'not running' });
  throw err;
}

const app = Fastify({ logger: false });

app.addHook('onResponse', async (request, reply) => {
  if (request.url.startsWith('/api/') && request.method !== 'GET') {
    console.log(`level=INFO msg="api request" method=${request.method} path=${JSON.stringify(request.url)} status=${reply.statusCode} ms=${reply.elapsedTime.toFixed(0)}`);
  }
});

// The whole console in one request: the customer list, the selected customer and line, the
// published routes, and the downstream drawer.
app.get<{ Querystring: { account?: string; line?: string } }>('/api/console', async (request) => {
  const { account, line } = request.query;
  const [customers, selected, selectedLine, systems, catalogue] = await Promise.all([
    list(PORTFOLIOS_QUERY, (memo) => {
      const p = memo?.portfolio as PortfolioView | undefined;
      return p && { accountId: p.accountId, lines: p.lines.map(({ undo: _undo, ...rest }) => rest), lastOrderAt: p.orders.at(-1)?.placedAt };
    }),
    account && ACCOUNT_ID.test(account) ? customer(account) : undefined,
    line && LINE_ID.test(line) ? lineDetail(line) : undefined,
    downstream('/admin/state').catch(() => undefined),
    downstream('/admin/routes').catch(() => undefined),
  ]);
  const routes = (catalogue?.routes ?? []) as Route[];
  return {
    customers: customers.sort((a, b) => (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? '')),
    selected: selected ?? null,
    // The route comes from the catalogue by version, rather than from the line's memo: a published
    // version never changes, so the memo needn't carry a copy.
    line: selectedLine
      ? {
          ...selectedLine,
          route: routes.find((r) => r.product === selectedLine.product && r.version === selectedLine.routeVersion) ?? null,
          replacedBy: selectedLine.replacedBy ?? selected?.portfolio.lines.find((l) => l.lineId === selectedLine.lineId)?.replacedBy,
        }
      : null,
    routes,
    downstream: systems ?? null,
    temporalUiUrl,
  };
});

// Places an order on a customer's portfolio, starting the portfolio if this is a new customer
// (Update-With-Start). The browser picks the order ID, which is also the Update ID, so a retried
// request is the same Update rather than a second order. Returns the portfolio as it is now.
app.post<{ Body: { accountId: string; orderId: string; items: OrderItem[]; bundleBehaviour?: BundleBehaviour } }>(
  '/api/orders',
  async (request, reply) => {
    const { accountId, orderId, items, bundleBehaviour } = request.body ?? {};
    if (!ACCOUNT_ID.test(accountId ?? '') || !ORDER_ID.test(orderId ?? '')) {
      return reply.code(400).send({ error: 'accountId must look like ACC-123456 and orderId like ORD-XXXXXX' });
    }
    const badItem = (items ?? []).find((item) =>
      item.type === 'ADD' ? !(item.product in PRODUCTS) || (item.replaces !== undefined && !LINE_ID.test(item.replaces)) : item.type !== 'CEASE' || !LINE_ID.test(item.lineId),
    );
    if (!Array.isArray(items) || badItem || (bundleBehaviour !== undefined && !['REVERT', 'PROVIDE'].includes(bundleBehaviour))) {
      return reply.code(400).send({ error: 'items must be ADD {product, replaces?} or CEASE {lineId}; bundleBehaviour REVERT or PROVIDE' });
    }
    const startPortfolio = new WithStartWorkflowOperation<typeof portfolio>('portfolio', {
      workflowId: portfolioWorkflowId(accountId),
      taskQueue,
      args: [{ accountId }],
      workflowIdConflictPolicy: 'USE_EXISTING',
      memo: { portfolio: { accountId, lines: [], orders: [], rev: 0 } satisfies PortfolioView },
      typedSearchAttributes: [{ key: AccountIdAttribute, value: accountId }],
    });
    try {
      const portfolioView = await client.workflow.executeUpdateWithStart(placeOrderUpdate, {
        args: [{ orderId, items, bundleBehaviour }],
        updateId: orderId,
        startWorkflowOperation: startPortfolio,
      });
      return reply.code(201).send(portfolioView);
    } catch (err) {
      return refused(err, reply);
    }
  },
);

// Stands in for a downstream system's callback (provider, logistics, engineer, partner).
// Fire-and-forget: the Workflow decides whether the event applies in its current state. That's the
// line while it's provisioning, and its cease once the line has activated and ended.
app.post<{ Params: { lineId: string }; Body: { type: EventName } }>('/api/lines/:lineId/events', async (request, reply) => {
  const { lineId } = request.params;
  const type = request.body?.type;
  if (!LINE_ID.test(lineId) || !(type in EVENTS)) {
    return reply.code(400).send({ error: `type must be one of ${Object.keys(EVENTS).join(', ')}` });
  }
  for (const workflowId of [lineWorkflowId(lineId), ceaseWorkflowId(lineId)]) {
    try {
      await client.workflow.getHandle(workflowId).signal(lineEventSignal, { type });
      return reply.code(202).send({ accepted: true, to: workflowId });
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
    }
  }
  return reply.code(409).send({ error: `nothing is running for ${lineId}, so no one is waiting for ${type}` });
});

// Moves a running line onto another version of its route, at its next gate.
app.post<{ Params: { lineId: string }; Body: { version: number; compensate: boolean } }>('/api/lines/:lineId/route', async (request, reply) => {
  const { lineId } = request.params;
  const { version, compensate } = request.body ?? {};
  if (!LINE_ID.test(lineId) || !Number.isInteger(version) || typeof compensate !== 'boolean') {
    return reply.code(400).send({ error: 'expected {version: integer, compensate: boolean}' });
  }
  try {
    return await client.workflow.getHandle(lineWorkflowId(lineId)).executeUpdate(changeRouteUpdate, { args: [{ version, compensate }] });
  } catch (err) {
    return refused(err, reply);
  }
});

// Publishes a new version of a product's route. Lines already running keep the version they
// started with; lines started from now on get this one.
app.post<{ Params: { product: ProductCode }; Body: Pick<Route, 'description' | 'stages'> }>('/api/routes/:product', async (request, reply) => {
  const { product } = request.params;
  const { description, stages } = request.body ?? {};
  const problems = routeProblems({ product, version: 0, description, stages });
  if (problems.length > 0) return reply.code(400).send({ error: problems.join('; '), problems });
  try {
    return reply.code(201).send(await downstream(`/catalogue/routes/${product}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, stages }),
    }));
  } catch (err) {
    return reply.code((err as { statusCode?: number }).statusCode ?? 502).send({ error: (err as Error).message });
  }
});

app.put<{ Params: { system: string }; Body: { mode: string } }>('/api/downstream/systems/:system', async (request) => {
  return downstream(`/admin/systems/${encodeURIComponent(request.params.system)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: request.body?.mode }),
  });
});

// Back to a clean slate: delete every portfolio, line and cease execution (the server terminates running
// ones first) and reset the simulated systems, including the catalogue's routes.
app.post('/api/reset', async () => {
  const executions = [];
  for await (const execution of client.workflow.list({ query: IN_DEMO })) {
    executions.push({ workflowId: execution.workflowId, runId: execution.runId });
  }
  histories.clear();
  await Promise.all([
    ...executions.map((workflowExecution) =>
      client.workflowService.deleteWorkflowExecution({ namespace, workflowExecution }).catch(() => undefined),
    ),
    downstream('/admin/reset', { method: 'POST' }),
  ]);
  return { deleted: executions.length };
});

if (consoleDir) {
  await app.register(fastifyStatic, { root: consoleDir });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

const port = Number(process.env.PORT ?? 8080);
await app.listen({ host: '0.0.0.0', port });
console.log(`level=INFO msg="fulfilment API listening" port=${port}`);
