// Shared types for the portfolio, its product lines, their routes, and the console. Nothing here
// touches the Temporal runtime, so Workflow code can import it.

// The Portfolio row lifecycle from the scenario's state models, plus CE for a line ceased after
// activation (the scenario document doesn't name that state):
//   BEGIN -> RQ -> AP -> AC -> CE
//   AP -> PAX -> CN          (cancelled before activation)
//   BEGIN/RQ -> CN           (cancelled before the provider accepted anything)
export type RowStatus = 'BEGIN' | 'RQ' | 'AP' | 'PAX' | 'CN' | 'AC' | 'CE';

export type ProductCode = 'BROADBAND_SUPERFAST' | 'BB_FIBRE_UNLIMITED_PRO' | 'SKY_TV' | 'NETFLIX';

export const PRODUCTS: Record<ProductCode, { name: string; broadband: boolean }> = {
  BROADBAND_SUPERFAST: { name: 'Broadband Superfast', broadband: true },
  BB_FIBRE_UNLIMITED_PRO: { name: 'Broadband Fibre Unlimited Pro', broadband: true },
  SKY_TV: { name: 'Sky TV', broadband: false },
  NETFLIX: { name: 'Netflix', broadband: false },
};

// How a replacement treats the in-flight line it replaces. Commerce decides this from the bundle.
//   REVERT  -> undo the old line's completed steps (provider cease by reference, recall kit...): AP -> PAX -> CN
//   PROVIDE -> one combined migrate order at the provider; the old row gets a CROSSGRADE cease and stays AP
export type BundleBehaviour = 'REVERT' | 'PROVIDE';

// --- Routes: the configurable part ----------------------------------------------------------
// A route says which steps a product goes through. Routes live outside the code, in the product
// catalogue, and are versioned. Each line loads its route once, when it starts, and keeps it.

// What fulfilment can do. Each action is an Activity in activities.ts; a route can only use these.
export const ACTIONS = [
  'provider.submitVoiceAndData',
  'provider.ceaseVoiceAndData',
  'logistics.dispatch',
  'logistics.recall',
  'engineer.bookVisit',
  'engineer.cancelVisit',
  'partner.activate',
  'partner.deactivate',
] as const;
export type ActionName = (typeof ACTIONS)[number];

// The action that reverses each forward action. A route's undo must be the matching one.
export const UNDO_OF: Partial<Record<ActionName, ActionName>> = {
  'provider.submitVoiceAndData': 'provider.ceaseVoiceAndData',
  'logistics.dispatch': 'logistics.recall',
  'engineer.bookVisit': 'engineer.cancelVisit',
  'partner.activate': 'partner.deactivate',
};

// The external events a gate can wait for, and which system sends each one.
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

export interface RouteStep {
  // Stable across versions: it's how a running line matches its progress onto a new version.
  id: string;
  name: string;
  action?: ActionName;
  params?: Record<string, string>;
  // The gate: the step isn't done until this event arrives.
  waitFor?: EventName;
  // The Portfolio row moves to AP when this step's action completes (the provider accepted it).
  accepted?: boolean;
  // How to reverse the step if the line is cancelled before activation.
  undo?: { action: ActionName; waitFor?: EventName };
}

// Stages run in order. The steps inside a stage run in parallel, and the next stage starts when
// all of them are done.
export interface RouteStage {
  name: string;
  steps: RouteStep[];
}

export interface Route {
  product: ProductCode;
  version: number;
  description: string;
  stages: RouteStage[];
}

// Checks a route only uses what fulfilment can do. Used by the API before publishing, and by the
// Activity that loads a route, so a line never starts on a route it can't run.
export function routeProblems(route: Route): string[] {
  const problems: string[] = [];
  if (!(route.product in PRODUCTS)) problems.push(`unknown product ${route.product}`);
  if (!Array.isArray(route.stages) || route.stages.length === 0) problems.push('a route needs at least one stage');
  const ids = new Set<string>();
  let accepted = 0;
  for (const stage of route.stages ?? []) {
    if (!stage.name) problems.push('every stage needs a name');
    if (!Array.isArray(stage.steps) || stage.steps.length === 0) problems.push(`stage "${stage.name}" has no steps`);
    for (const step of stage.steps ?? []) {
      if (!step.id || !/^[a-z0-9-]+$/.test(step.id)) problems.push(`step id "${step.id}" must be lowercase letters, digits and dashes`);
      if (ids.has(step.id)) problems.push(`step id "${step.id}" is used twice`);
      ids.add(step.id);
      if (!step.name) problems.push(`step "${step.id}" needs a name`);
      if (!step.action && !step.waitFor) problems.push(`step "${step.id}" needs an action, a waitFor, or both`);
      if (step.action && !ACTIONS.includes(step.action)) problems.push(`step "${step.id}": unknown action ${step.action}`);
      if (step.waitFor && !(step.waitFor in EVENTS)) problems.push(`step "${step.id}": unknown event ${step.waitFor}`);
      if (step.undo && (!step.action || UNDO_OF[step.action] !== step.undo.action)) {
        problems.push(`step "${step.id}": the undo for ${step.action ?? 'a gate'} must be ${step.action ? UNDO_OF[step.action] : 'left out'}`);
      }
      if (step.undo?.waitFor && !(step.undo.waitFor in EVENTS)) problems.push(`step "${step.id}": unknown undo event ${step.undo.waitFor}`);
      if (step.accepted) {
        accepted++;
        if (!step.action) problems.push(`step "${step.id}" is marked accepted but has no action`);
      }
    }
  }
  if (accepted !== 1) problems.push('exactly one step must be marked accepted (it moves the row to AP)');
  return problems;
}

// --- Orders -------------------------------------------------------------------------------------

export type OrderItem =
  | { type: 'ADD'; product: ProductCode; replaces?: string }
  | { type: 'CEASE'; lineId: string };

export interface PlaceOrderRequest {
  orderId: string;
  items: OrderItem[];
  bundleBehaviour?: BundleBehaviour;
}

export interface OrderRecord {
  orderId: string;
  placedAt: string;
  items: OrderItem[];
  bundleBehaviour?: BundleBehaviour;
  lineIds: string[];
}

// --- Product lines ------------------------------------------------------------------------------

export type LineStatus = 'PROVISIONING' | 'ACTIVE' | 'CANCELLED' | 'MIGRATED' | 'CEASED';

export type StepState = 'pending' | 'running' | 'waiting' | 'done' | 'undoing' | 'undone' | 'dropped';

export interface LineInput {
  lineId: string;
  accountId: string;
  orderId: string;
  product: ProductCode;
  // Set when this line replaces another: it waits for that line to be released before it
  // submits anything, and learns then whether to migrate.
  replaces?: string;
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
  billing: Billing;
}

export interface Billing {
  since?: string;
  until?: string;
}

export interface TimelineEntry {
  at: string;
  text: string;
  // 'ignored' marks an event that arrived in a state where it changes nothing: logged, no transition.
  tone: 'info' | 'ignored';
}


// The line as the console shows it. The Workflow keeps this in its memo, so the API reads it with
// Describe or List and no Worker is involved.
export interface LineView extends LineSummary {
  accountId: string;
  route?: Route;
  steps: Record<string, StepState>;
  awaiting: EventName[];
  // Steps a route change took out of this line, and what happened to them.
  retired: { id: string; name: string; fromVersion: number; state: StepState }[];
  phase: string;
  timeline: TimelineEntry[];
}

export function newLineView(input: LineInput): LineView {
  return {
    ...input,
    status: 'PROVISIONING',
    rowStatus: 'BEGIN',
    billing: {},
    steps: {},
    awaiting: [],
    retired: [],
    phase: input.replaces ? `Held until ${input.replaces} is released` : 'Waiting for a Worker to load its route',
    timeline: [],
  };
}

export function lineSummary(view: LineView): LineSummary {
  const { lineId, orderId, product, status, rowStatus, routeVersion, providerOrderRef, replaces, replacedBy, billing } = view;
  return { lineId, orderId, product, status, rowStatus, routeVersion, providerOrderRef, replaces, replacedBy, billing };
}

// What a line tells the portfolio when it lets go of the customer's line for its replacement.
export interface Release {
  lineId: string;
  // CANCELLED: undone at the provider. MIGRATED: hand this provider order to the replacement.
  // ACTIVE: already activated, so the replacement crossgrades the live service.
  outcome: 'CANCELLED' | 'MIGRATED' | 'ACTIVE';
  migrateFrom?: string;
}

// --- Portfolio ------------------------------------------------------------------------------------

// The portfolio's copy of each line, plus what the portfolio itself has asked of it.
export interface PortfolioLine extends LineSummary {
  ceaseRequested?: boolean;
}

export interface PortfolioView {
  accountId: string;
  lines: PortfolioLine[];
  orders: OrderRecord[];
  timeline: TimelineEntry[];
}

export function portfolioWorkflowId(accountId: string): string {
  return `portfolio-${accountId}`;
}

export function lineIdFor(orderId: string, n: number): string {
  return `${orderId}-${n}`;
}

export function lineWorkflowId(lineId: string): string {
  return `line-${lineId}`;
}
