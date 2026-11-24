// The console's view of the fulfilment API. Types and constants mirror fulfilment/src/domain.ts.

export type RowStatus = 'BEGIN' | 'RQ' | 'AP' | 'PAX' | 'CN' | 'AC' | 'CE';
export type ProductCode = 'BROADBAND_SUPERFAST' | 'BB_FIBRE_UNLIMITED_PRO' | 'SKY_TV' | 'NETFLIX';
export type BundleBehaviour = 'REVERT' | 'PROVIDE';
export type LineStatus = 'PROVISIONING' | 'ACTIVE' | 'CANCELLED' | 'MIGRATED' | 'CEASED';
export type StepState = 'pending' | 'running' | 'waiting' | 'done' | 'undoing' | 'undone' | 'dropped';
export type Mode = 'healthy' | 'slow' | 'failing';

export const PRODUCTS: Record<ProductCode, { name: string; short: string; broadband: boolean }> = {
  BROADBAND_SUPERFAST: { name: 'Broadband Superfast', short: 'Superfast', broadband: true },
  BB_FIBRE_UNLIMITED_PRO: { name: 'Broadband Fibre Unlimited Pro', short: 'Fibre Pro', broadband: true },
  SKY_TV: { name: 'Sky TV', short: 'Sky TV', broadband: false },
  NETFLIX: { name: 'Netflix', short: 'Netflix', broadband: false },
};
export const PRODUCT_CODES = Object.keys(PRODUCTS) as ProductCode[];

export const EVENTS = {
  VOICE_AND_DATA_ORDER_COMPLETED: 'SNS/OSS provider',
  DATA_ACTIVATED: 'SNS/OSS provider',
  CANCEL_ORDER_COMPLETED: 'SNS/OSS provider',
  KIT_DELIVERED: 'Logistics',
  BOX_DELIVERED: 'Logistics',
  ENGINEER_VISIT_COMPLETED: 'Field engineering',
  PARTNER_ACTIVATION_ACKNOWLEDGED: 'Partner (Netflix)',
} as const;
export type EventName = keyof typeof EVENTS;
export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

// What each forward action does, the parameter it takes, and the action that reverses it.
export const ACTIONS = {
  'provider.submitVoiceAndData': { label: 'Voice and data order to the provider', undo: 'provider.ceaseVoiceAndData', param: undefined },
  'logistics.dispatch': { label: 'Dispatch kit', undo: 'logistics.recall', param: 'item' },
  'engineer.bookVisit': { label: 'Book an engineer visit', undo: 'engineer.cancelVisit', param: 'job' },
  'partner.activate': { label: 'Create a partner account', undo: 'partner.deactivate', param: 'partner' },
} as const;
export type ForwardAction = keyof typeof ACTIONS;
export type ActionName = ForwardAction | (typeof ACTIONS)[ForwardAction]['undo'];

export interface RouteStep {
  id: string;
  name: string;
  action?: ActionName;
  params?: Record<string, string>;
  waitFor?: EventName;
  accepted?: boolean;
  undo?: { action: ActionName; waitFor?: EventName };
}

export interface Route {
  product: ProductCode;
  version: number;
  description: string;
  stages: { name: string; steps: RouteStep[] }[];
  publishedAt?: string;
}

export interface TimelineEntry {
  at: string;
  text: string;
  tone: 'info' | 'ignored';
}

export interface LineSummary {
  lineId: string;
  orderId: string;
  product: ProductCode;
  status: LineStatus;
  rowStatus: RowStatus;
  routeVersion?: number;
  providerOrderRef?: string;
  replaces?: string;
  replacedBy?: string;
  billing: { since?: string; until?: string };
}

export interface LineListItem extends LineSummary {
  accountId: string;
  steps: Record<string, StepState>;
  awaiting: EventName[];
  phase: string;
  // Set once the portfolio has started a cease for this live line.
  cease: { status: 'CEASING' | 'CEASED' } | null;
}

// A live line's cease, which runs as its own Workflow after the line's Workflow has ended.
export interface CeaseView {
  lineId: string;
  reason: string;
  replacedBy?: string;
  status: 'CEASING' | 'CEASED';
  rowStatus: RowStatus;
  steps: { stepId: string; name: string; state: StepState }[];
  awaiting: EventName[];
  phase: string;
}

export interface PendingWork {
  activity: string;
  attempt: number;
  lastFailure?: string;
  nextAttemptAt?: string;
}

export interface LineDetail extends Omit<LineListItem, 'cease'> {
  route: Route | null;
  retired: { id: string; name: string; fromVersion: number; state: StepState }[];
  cease: CeaseView | null;
  // From the Workflows' history Query. historyCurrent is false when no Worker answered it, so the
  // entries (if any) are the last ones the API saw.
  timeline: TimelineEntry[];
  historyCurrent: boolean;
  pendingWork: PendingWork[];
  temporalUrl: string;
  ceaseTemporalUrl: string | null;
}

export type OrderItem = { type: 'ADD'; product: ProductCode; replaces?: string } | { type: 'CEASE'; lineId: string };

export type PortfolioLine = LineSummary & { ceaseRequested?: boolean; ceaseStarted?: boolean; released?: boolean };

export interface Portfolio {
  accountId: string;
  lines: PortfolioLine[];
  orders: { orderId: string; placedAt: string; items: OrderItem[]; bundleBehaviour?: BundleBehaviour; lineIds: string[] }[];
}

export interface CustomerSummary {
  accountId: string;
  lines: LineSummary[];
  lastOrderAt?: string;
}

export interface Job {
  ref: string;
  lineId: string;
  what: string;
  state: string;
}

export const SYSTEMS = ['catalogue', 'portfolio', 'provider', 'logistics', 'engineering', 'partner', 'billing'] as const;
export type System = (typeof SYSTEMS)[number];

export interface DownstreamState {
  modes: Record<System, Mode>;
  portfolioRows: { lineId: string; accountId: string; product: ProductCode; status: RowStatus; history: { at: string; text: string }[] }[];
  providerOrders: { providerOrderRef: string; lineId: string; type: string; migrateFrom?: string; state: string }[];
  consignments: Job[];
  visits: Job[];
  partnerAccounts: Job[];
  subscriptions: { lineId: string; accountId: string; product: ProductCode; since: string; until?: string }[];
}

export interface ConsoleData {
  customers: CustomerSummary[];
  selected: {
    portfolio: Portfolio;
    lines: LineListItem[];
    timeline: TimelineEntry[];
    historyCurrent: boolean;
    pendingWork: PendingWork[];
    temporalUrl: string;
  } | null;
  line: LineDetail | null;
  routes: Route[];
  downstream: DownstreamState | null;
  temporalUiUrl: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

const post = <T,>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  console: (selection: { account?: string; line?: string }, signal: AbortSignal) => {
    const query = new URLSearchParams(Object.entries(selection).filter(([, v]) => v) as [string, string][]);
    return request<ConsoleData>(`/api/console?${query}`, { signal });
  },
  // Every customer change is an order on their portfolio: new products, upgrades, cancellations.
  placeOrder: (accountId: string, items: OrderItem[], bundleBehaviour?: BundleBehaviour) =>
    post<Portfolio>('/api/orders', { accountId, orderId: newOrderId(), items, bundleBehaviour }),
  sendEvent: (lineId: string, type: EventName) => post<{ accepted: boolean; to: string }>(`/api/lines/${lineId}/events`, { type }),
  changeRoute: (lineId: string, version: number, compensate: boolean) => post<{ version: number }>(`/api/lines/${lineId}/route`, { version, compensate }),
  publishRoute: (route: Pick<Route, 'product' | 'description' | 'stages'>) =>
    post<Route>(`/api/routes/${route.product}`, { description: route.description, stages: route.stages }),
  setMode: (system: System, mode: Mode) =>
    request<{ modes: DownstreamState['modes'] }>(`/api/downstream/systems/${system}`, { method: 'PUT', body: JSON.stringify({ mode }) }),
  reset: () => post<{ deleted: number }>('/api/reset', {}),
};

// IDs are chosen in the browser: the order ID is also the Update ID, so a retried request can't
// place the same order twice.
const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function newOrderId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `ORD-${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}
export function newAccountId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `ACC-${[...bytes].map((b) => b % 10).join('')}`;
}
