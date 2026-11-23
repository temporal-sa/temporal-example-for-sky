// Simulated downstream systems: the product catalogue, Portfolio, the SNS/OSS provider, logistics,
// field engineering, a partner (Netflix) and billing. They stand in for real services so
// fulfilment makes real HTTP calls, and each can be switched to slow or failing from the console's
// Downstream systems drawer. State is in memory and resets on restart.
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { SEED_ROUTES } from './routes.js';

type RowStatus = 'BEGIN' | 'RQ' | 'AP' | 'PAX' | 'CN' | 'AC' | 'CE';
type Mode = 'healthy' | 'slow' | 'failing';
const SYSTEMS = ['catalogue', 'portfolio', 'provider', 'logistics', 'engineering', 'partner', 'billing'] as const;
type System = (typeof SYSTEMS)[number];

interface HistoryEntry {
  at: string;
  text: string;
}

interface Route {
  product: string;
  version: number;
  description: string;
  stages: unknown[];
  publishedAt: string;
}

interface PortfolioRow {
  lineId: string;
  accountId: string;
  orderId: string;
  product: string;
  replaces?: string;
  status: RowStatus;
  history: HistoryEntry[];
}

interface ProviderOrder {
  providerOrderRef: string;
  lineId: string;
  accountId: string;
  type: 'PROVIDE_VOICE_AND_DATA' | 'MIGRATE_DATA_MIGRATE_VOICE';
  migrateFrom?: string;
  state: 'OPEN' | 'CEASE_REQUESTED' | 'MIGRATED';
}

interface Job {
  ref: string;
  key: string;
  lineId: string;
  what: string;
  state: string;
}

interface Subscription {
  lineId: string;
  accountId: string;
  product: string;
  since: string;
  until?: string;
}

// The Portfolio row state model from the scenario, with CE for a line ceased after activation.
// Anything else is refused with 409, so a fulfilment bug that skips a state shows up as a rejected
// call rather than a quietly wrong row.
const ALLOWED: Record<RowStatus, RowStatus[]> = {
  BEGIN: ['RQ', 'CN'],
  RQ: ['AP', 'CN'],
  AP: ['AC', 'PAX'],
  PAX: ['CN'],
  CN: [],
  AC: ['CE'],
  CE: [],
};

const SLOW_MS = 3_000;
const now = () => new Date().toISOString();

const modes = Object.fromEntries(SYSTEMS.map((s) => [s, 'healthy'])) as Record<System, Mode>;
let routes: Route[] = [];
const rows = new Map<string, PortfolioRow>();
const providerOrders = new Map<string, ProviderOrder>();
const consignments = new Map<string, Job>();
const visits = new Map<string, Job>();
const partnerAccounts = new Map<string, Job>();
const subscriptions = new Map<string, Subscription>();
let nextRef = 1000;

function reset(): void {
  for (const system of SYSTEMS) modes[system] = 'healthy';
  routes = SEED_ROUTES.map((route) => ({ ...route, publishedAt: now() }));
  for (const map of [rows, providerOrders, consignments, visits, partnerAccounts, subscriptions]) map.clear();
  nextRef = 1000;
}
reset();

const app = Fastify({ logger: { level: 'warn' } });

// Applies the system's simulated health before its handler runs.
function simulated(system: System) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    if (modes[system] === 'failing') {
      return reply.code(503).send({ error: `${system} is unavailable (simulated outage)` });
    }
    if (modes[system] === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    }
  };
}

// A job keyed by line and step, so a retried request gets the reference already issued.
function createJob(jobs: Map<string, Job>, prefix: string, key: string, lineId: string, what: string, state: string): Job {
  const existing = [...jobs.values()].find((job) => job.key === key);
  if (existing) return existing;
  const job = { ref: `${prefix}-${nextRef++}`, key, lineId, what, state };
  jobs.set(job.ref, job);
  return job;
}

function updateJob(jobs: Map<string, Job>, ref: string, state: string, reply: FastifyReply) {
  const job = jobs.get(ref);
  if (!job) return reply.code(404).send({ error: `no ${ref}` });
  job.state = state;
  return { state };
}

// --- Product catalogue ------------------------------------------------------------------------------

app.register(async (catalogue) => {
  catalogue.addHook('onRequest', simulated('catalogue'));

  catalogue.get('/catalogue/routes', async () => ({ routes }));

  catalogue.get<{ Params: { product: string; version: string } }>('/catalogue/routes/:product/:version', async (request, reply) => {
    const { product, version } = request.params;
    const versions = routes.filter((r) => r.product === product);
    const route = version === 'current' ? versions.at(-1) : versions.find((r) => r.version === Number(version));
    if (!route) return reply.code(404).send({ error: `no route for ${product} version ${version}` });
    return route;
  });

  // Publishes the next version. The fulfilment API checks the route before it gets here.
  catalogue.post<{ Params: { product: string }; Body: { description: string; stages: unknown[] } }>(
    '/catalogue/routes/:product',
    async (request, reply) => {
      const { product } = request.params;
      const versions = routes.filter((r) => r.product === product);
      if (versions.length === 0) return reply.code(404).send({ error: `unknown product ${product}` });
      const route = { product, version: versions.at(-1)!.version + 1, description: request.body.description, stages: request.body.stages, publishedAt: now() };
      routes.push(route);
      return route;
    },
  );
});

// --- Portfolio ---------------------------------------------------------------------------------------

app.register(async (portfolio) => {
  portfolio.addHook('onRequest', simulated('portfolio'));

  portfolio.post<{ Body: { accountId: string; orderId: string; lines: { lineId: string; product: string; replaces?: string }[] } }>(
    '/portfolio/registerPortfolioChanges',
    async (request) => {
      const { accountId, orderId, lines } = request.body;
      // Idempotent: a retried registration keeps the existing rows.
      for (const line of lines) {
        if (!rows.has(line.lineId)) {
          rows.set(line.lineId, { ...line, accountId, orderId, status: 'BEGIN', history: [{ at: now(), text: 'Registered (BEGIN)' }] });
        }
      }
      return { registered: lines.length };
    },
  );

  portfolio.post<{ Params: { lineId: string }; Body: { status: RowStatus; reason: string } }>(
    '/portfolio/rows/:lineId/status',
    async (request, reply) => {
      const row = rows.get(request.params.lineId);
      if (!row) return reply.code(404).send({ error: `no portfolio row for ${request.params.lineId}` });
      const { status, reason } = request.body;
      if (row.status === status) return { status }; // a retry of a move that already happened
      if (!ALLOWED[row.status].includes(status)) {
        return reply.code(409).send({ error: `row ${row.lineId} can't move ${row.status} -> ${status}` });
      }
      row.history.push({ at: now(), text: `${row.status} -> ${status} (${reason})` });
      row.status = status;
      return { status };
    },
  );

  portfolio.post<{ Params: { lineId: string }; Body: { note: string } }>('/portfolio/rows/:lineId/events', async (request, reply) => {
    const row = rows.get(request.params.lineId);
    if (!row) return reply.code(404).send({ error: `no portfolio row for ${request.params.lineId}` });
    if (row.history.at(-1)?.text !== request.body.note) row.history.push({ at: now(), text: request.body.note });
    return { status: row.status };
  });
});

// --- SNS/OSS provider --------------------------------------------------------------------------------

app.register(async (provider) => {
  provider.addHook('onRequest', simulated('provider'));

  provider.post<{ Body: { lineId: string; accountId: string; type: ProviderOrder['type']; migrateFrom?: string } }>(
    '/provider/orders',
    async (request, reply) => {
      const { lineId, accountId, type, migrateFrom } = request.body;
      const existing = [...providerOrders.values()].find((o) => o.lineId === lineId);
      if (existing) return { providerOrderRef: existing.providerOrderRef };
      if (migrateFrom) {
        const from = providerOrders.get(migrateFrom);
        if (!from) return reply.code(404).send({ error: `no provider order ${migrateFrom} to migrate from` });
        from.state = 'MIGRATED';
      }
      const providerOrderRef = `SNS-${nextRef++}`;
      providerOrders.set(providerOrderRef, { providerOrderRef, lineId, accountId, type, migrateFrom, state: 'OPEN' });
      return { providerOrderRef };
    },
  );

  provider.post<{ Params: { ref: string } }>('/provider/orders/:ref/cease', async (request, reply) => {
    const order = providerOrders.get(request.params.ref);
    if (!order) return reply.code(404).send({ error: `no provider order ${request.params.ref}` });
    order.state = 'CEASE_REQUESTED';
    return { state: order.state };
  });
});

// --- Logistics, field engineering, partner ----------------------------------------------------------

app.register(async (logistics) => {
  logistics.addHook('onRequest', simulated('logistics'));
  logistics.post<{ Body: { lineId: string; stepId: string; item: string } }>('/logistics/consignments', async (request) => {
    const { lineId, stepId, item } = request.body;
    return { consignmentRef: createJob(consignments, 'CON', `${lineId}/${stepId}`, lineId, item, 'DISPATCHED').ref };
  });
  logistics.post<{ Params: { ref: string } }>('/logistics/consignments/:ref/recall', async (request, reply) =>
    updateJob(consignments, request.params.ref, 'RECALL_BOOKED', reply),
  );
});

app.register(async (engineering) => {
  engineering.addHook('onRequest', simulated('engineering'));
  engineering.post<{ Body: { lineId: string; stepId: string; job: string } }>('/engineering/visits', async (request) => {
    const { lineId, stepId, job } = request.body;
    return { visitRef: createJob(visits, 'VIS', `${lineId}/${stepId}`, lineId, job, 'BOOKED').ref };
  });
  engineering.post<{ Params: { ref: string } }>('/engineering/visits/:ref/cancel', async (request, reply) =>
    updateJob(visits, request.params.ref, 'CANCELLED', reply),
  );
});

app.register(async (partner) => {
  partner.addHook('onRequest', simulated('partner'));
  partner.post<{ Body: { lineId: string; partner: string } }>('/partner/accounts', async (request) => {
    const { lineId, partner: name } = request.body;
    return { partnerRef: createJob(partnerAccounts, 'NFX', lineId, lineId, name, 'REQUESTED').ref };
  });
  partner.post<{ Params: { ref: string } }>('/partner/accounts/:ref/deactivate', async (request, reply) =>
    updateJob(partnerAccounts, request.params.ref, 'DEACTIVATED', reply),
  );
});

// --- Billing -----------------------------------------------------------------------------------------

app.register(async (billing) => {
  billing.addHook('onRequest', simulated('billing'));
  billing.post<{ Body: { lineId: string; accountId: string; product: string } }>('/billing/subscriptions', async (request) => {
    const { lineId, accountId, product } = request.body;
    if (!subscriptions.has(lineId)) subscriptions.set(lineId, { lineId, accountId, product, since: now() });
    return subscriptions.get(lineId);
  });
  billing.post<{ Params: { lineId: string } }>('/billing/subscriptions/:lineId/stop', async (request, reply) => {
    const subscription = subscriptions.get(request.params.lineId);
    if (!subscription) return reply.code(404).send({ error: `no subscription for ${request.params.lineId}` });
    subscription.until ??= now();
    return subscription;
  });
});

// --- Admin, used by the console's drawer through the fulfilment API ---------------------------------

app.get('/admin/state', async () => ({
  modes,
  portfolioRows: [...rows.values()].reverse(),
  providerOrders: [...providerOrders.values()].reverse(),
  consignments: [...consignments.values()].reverse(),
  visits: [...visits.values()].reverse(),
  partnerAccounts: [...partnerAccounts.values()].reverse(),
  subscriptions: [...subscriptions.values()].reverse(),
}));

// The catalogue's routes without its simulated health, so the console's Routes page always loads.
app.get('/admin/routes', async () => ({ routes }));

app.put<{ Params: { system: string }; Body: { mode: Mode } }>('/admin/systems/:system', async (request, reply) => {
  const system = request.params.system as System;
  const { mode } = request.body;
  if (!SYSTEMS.includes(system) || !['healthy', 'slow', 'failing'].includes(mode)) {
    return reply.code(400).send({ error: `expected system ${SYSTEMS.join('|')} and mode healthy|slow|failing` });
  }
  modes[system] = mode;
  return { modes };
});

app.post('/admin/reset', async () => {
  reset();
  return { modes };
});

const port = Number(process.env.PORT ?? 8090);
await app.listen({ host: '0.0.0.0', port });
console.log(`level=INFO msg="downstream systems listening" port=${port}`);
