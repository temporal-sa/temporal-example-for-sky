// The fulfilment console's API. The console loads from one request (GET /api/console), and each
// action is one request that makes one Temporal call. State comes from the Workflows' memo through
// List and Describe, never a Query, so the console keeps working while the Worker is down.
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
  EVENTS,
  type EventName,
  type LineView,
  type OrderItem,
  type PortfolioView,
  PRODUCTS,
  type ProductCode,
  type Route,
  lineWorkflowId,
  portfolioWorkflowId,
  routeProblems,
} from './domain.js';
import { changeRouteUpdate, lineEventSignal, placeOrderUpdate } from './messages.js';
import { AccountIdAttribute } from './search-attributes.js';
import type { portfolio } from './workflows.js';

const taskQueue = requiredEnv('TEMPORAL_TASK_QUEUE');
const downstreamUrl = requiredEnv('DOWNSTREAM_URL');
const temporalUiUrl = requiredEnv('TEMPORAL_UI_URL');
const consoleDir = process.env.CONSOLE_DIR;
const { connectionOptions, namespace } = temporalConfig();

const client = new Client({ connection: await Connection.connect(connectionOptions), namespace });

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

async function lineDetail(lineId: string) {
  const description = await describe(lineWorkflowId(lineId));
  const line = description?.memo?.line as LineView | undefined;
  if (!description || !line) return undefined;
  return { ...line, pendingWork: pendingWork(description), temporalUrl: executionUrl(lineWorkflowId(lineId)) };
}

async function customer(accountId: string) {
  const id = portfolioWorkflowId(accountId);
  const [description, lines] = await Promise.all([
    describe(id),
    list(`WorkflowType="productLine" AND AccountId="${accountId}" AND ${IN_DEMO}`, (memo) => memo?.line as LineView | undefined),
  ]);
  const portfolio = description?.memo?.portfolio as PortfolioView | undefined;
  if (!portfolio) return undefined;
  return {
    portfolio,
    // In the order the portfolio took them on, so a replacement sits after the line it replaces.
    lines: lines
      .map(({ timeline: _timeline, route: _route, ...rest }) => rest)
      .sort((a, b) => portfolio.lines.findIndex((l) => l.lineId === a.lineId) - portfolio.lines.findIndex((l) => l.lineId === b.lineId)),
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
      return p && { accountId: p.accountId, lines: p.lines, lastOrderAt: p.orders.at(-1)?.placedAt };
    }),
    account && ACCOUNT_ID.test(account) ? customer(account) : undefined,
    line && LINE_ID.test(line) ? lineDetail(line) : undefined,
    downstream('/admin/state').catch(() => undefined),
    downstream('/admin/routes').catch(() => undefined),
  ]);
  return {
    customers: customers.sort((a, b) => (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? '')),
    selected: selected ?? null,
    line: selectedLine ?? null,
    routes: (catalogue?.routes ?? []) as Route[],
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
      memo: { portfolio: { accountId, lines: [], orders: [], timeline: [] } satisfies PortfolioView },
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
// Fire-and-forget: the line decides whether the event applies in its current state.
app.post<{ Params: { lineId: string }; Body: { type: EventName } }>('/api/lines/:lineId/events', async (request, reply) => {
  const { lineId } = request.params;
  const type = request.body?.type;
  if (!LINE_ID.test(lineId) || !(type in EVENTS)) {
    return reply.code(400).send({ error: `type must be one of ${Object.keys(EVENTS).join(', ')}` });
  }
  try {
    await client.workflow.getHandle(lineWorkflowId(lineId)).signal(lineEventSignal, { type });
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return reply.code(404).send({ error: `line ${lineId} is not running` });
    throw err;
  }
  return reply.code(202).send({ accepted: true });
});

// Moves a running line onto another version of its route. Returns the line as it is now.
app.post<{ Params: { lineId: string }; Body: { version: number; compensate: boolean } }>('/api/lines/:lineId/route', async (request, reply) => {
  const { lineId } = request.params;
  const { version, compensate } = request.body ?? {};
  if (!LINE_ID.test(lineId) || !Number.isInteger(version) || typeof compensate !== 'boolean') {
    return reply.code(400).send({ error: 'expected {version: integer, compensate: boolean}' });
  }
  try {
    await client.workflow.getHandle(lineWorkflowId(lineId)).executeUpdate(changeRouteUpdate, { args: [{ version, compensate }] });
  } catch (err) {
    return refused(err, reply);
  }
  return lineDetail(lineId);
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

// Back to a clean slate: delete every portfolio and line execution (the server terminates running
// ones first) and reset the simulated systems, including the catalogue's routes.
app.post('/api/reset', async () => {
  const executions = [];
  for await (const execution of client.workflow.list({ query: IN_DEMO })) {
    executions.push({ workflowId: execution.workflowId, runId: execution.runId });
  }
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
