import { ApplicationFailure, log } from '@temporalio/activity';
import { type ProductCode, type Route, type RowStatus, routeProblems } from './domain.js';

// Activities are the only code that talks to the outside world: the product catalogue, Portfolio,
// the SNS/OSS provider, logistics, field engineering, partners and billing, all over HTTP. Every
// call is safe to repeat, because Temporal retries an attempt whose result it never heard back:
// each system treats a repeat of the same line and step as the same request.
export function createActivities(downstreamUrl: string) {
  async function call<T>(system: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${downstreamUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await response.text();
    if (response.status >= 500) {
      // An outage is worth retrying; the Retry Policy on the Workflow's Activity proxy does it.
      throw ApplicationFailure.retryable(`${system} unavailable: HTTP ${response.status} ${text}`, `${system}Unavailable`);
    }
    if (!response.ok) {
      // A 4xx means the request itself is wrong. Retrying won't change the answer.
      throw ApplicationFailure.nonRetryable(`${system} rejected the request: HTTP ${response.status} ${text}`, `${system}Rejected`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const post = <T = void>(system: string, path: string, body: unknown) => call<T>(system, 'POST', path, body);

  return {
    // Product catalogue: the route a product follows. Without a version, the one published now.
    // The result is recorded in the line's Event History, which is what pins the line to it.
    async loadRoute(product: ProductCode, version?: number): Promise<Route> {
      const route = await call<Route>('Catalogue', 'GET', `/catalogue/routes/${product}/${version ?? 'current'}`);
      const problems = routeProblems(route);
      if (problems.length > 0) {
        throw ApplicationFailure.nonRetryable(`route ${product} v${route.version} can't be run: ${problems.join('; ')}`, 'RouteInvalid');
      }
      return route;
    },

    // Portfolio: one row per product line, with its lifecycle (BEGIN, RQ, AP, PAX, CN, AC, CE).
    async registerPortfolioChanges(change: { accountId: string; orderId: string; lines: { lineId: string; product: ProductCode; replaces?: string }[] }): Promise<void> {
      await post('Portfolio', '/portfolio/registerPortfolioChanges', change);
      log.info('portfolio changes registered', { account: change.accountId, order: change.orderId, lines: change.lines.length });
    },

    async setPortfolioRowStatus(lineId: string, status: RowStatus, reason: string): Promise<void> {
      await post('Portfolio', `/portfolio/rows/${lineId}/status`, { status, reason });
      log.info('portfolio row moved', { line: lineId, status, reason });
    },

    async logPortfolioRowEvent(lineId: string, note: string): Promise<void> {
      await post('Portfolio', `/portfolio/rows/${lineId}/events`, { note });
    },

    // SNS/OSS provider. Idempotent on the line ID: a repeat returns the reference already issued.
    async submitVoiceAndDataOrder(request: { lineId: string; accountId: string; product: ProductCode; migrateFrom?: string }): Promise<string> {
      const { providerOrderRef } = await post<{ providerOrderRef: string }>('Provider', '/provider/orders', {
        ...request,
        type: request.migrateFrom ? 'MIGRATE_DATA_MIGRATE_VOICE' : 'PROVIDE_VOICE_AND_DATA',
      });
      log.info('voice and data order accepted by provider', { line: request.lineId, providerOrderRef });
      return providerOrderRef;
    },

    async ceaseVoiceAndDataOrder(providerOrderRef: string): Promise<string> {
      await post('Provider', `/provider/orders/${providerOrderRef}/cease`, {});
      log.info('cease sent to provider', { providerOrderRef });
      return providerOrderRef;
    },

    // Logistics: kit sent to the customer, and collected again if the line is cancelled.
    async dispatchKit(request: { lineId: string; stepId: string; item: string }): Promise<string> {
      const { consignmentRef } = await post<{ consignmentRef: string }>('Logistics', '/logistics/consignments', request);
      log.info('kit dispatched', { line: request.lineId, item: request.item, consignmentRef });
      return consignmentRef;
    },

    async recallKit(consignmentRef: string): Promise<string> {
      await post('Logistics', `/logistics/consignments/${consignmentRef}/recall`, {});
      log.info('kit recall booked', { consignmentRef });
      return consignmentRef;
    },

    // Field engineering.
    async bookEngineerVisit(request: { lineId: string; stepId: string; job: string }): Promise<string> {
      const { visitRef } = await post<{ visitRef: string }>('Engineering', '/engineering/visits', request);
      log.info('engineer visit booked', { line: request.lineId, visitRef });
      return visitRef;
    },

    async cancelEngineerVisit(visitRef: string): Promise<string> {
      await post('Engineering', `/engineering/visits/${visitRef}/cancel`, {});
      log.info('engineer visit cancelled', { visitRef });
      return visitRef;
    },

    // Partners such as Netflix, whose account is created by us and acknowledged by them.
    async activatePartnerAccount(request: { lineId: string; partner: string }): Promise<string> {
      const { partnerRef } = await post<{ partnerRef: string }>('Partner', '/partner/accounts', request);
      log.info('partner account requested', { line: request.lineId, partner: request.partner, partnerRef });
      return partnerRef;
    },

    async deactivatePartnerAccount(partnerRef: string): Promise<string> {
      await post('Partner', `/partner/accounts/${partnerRef}/deactivate`, {});
      log.info('partner account deactivated', { partnerRef });
      return partnerRef;
    },

    // Billing. A line is billed from the moment it activates until it's ceased, and never before.
    async startBilling(request: { lineId: string; accountId: string; product: ProductCode }): Promise<void> {
      await post('Billing', '/billing/subscriptions', request);
      log.info('billing started', { line: request.lineId });
    },

    async stopBilling(lineId: string): Promise<void> {
      await post('Billing', `/billing/subscriptions/${lineId}/stop`, {});
      log.info('billing stopped', { line: lineId });
    },
  };
}

export type FulfilmentActivities = ReturnType<typeof createActivities>;
