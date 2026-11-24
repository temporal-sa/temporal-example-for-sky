import { defineQuery, defineSignal, defineUpdate } from '@temporalio/workflow';
import type { BundleBehaviour, EventName, LineSummary, PlaceOrderRequest, PortfolioView, Release, TimelineEntry } from './domain.js';

// The messages the three Workflows (portfolio, productLine, ceaseLine) accept. Kept apart from the Workflow code so the API and the
// tests can import them without pulling in Workflow code.

// --- Portfolio --------------------------------------------------------------------------------

// Every order for a customer goes through their portfolio. An Update, not a Signal, because the
// console needs to know whether the order was accepted: the validator refuses an order that
// conflicts with what the portfolio already holds, before anything is written to history.
export const placeOrderUpdate = defineUpdate<PortfolioView, [PlaceOrderRequest]>('placeOrder');

// A line, or the Workflow ceasing it, reporting progress, so the portfolio's view of the customer
// stays current.
export const lineChangedSignal = defineSignal<[LineSummary]>('lineChanged');

// A line letting go of the customer's line so its replacement can proceed.
export const lineReleasedSignal = defineSignal<[Release]>('lineReleased');

// --- Product line -----------------------------------------------------------------------------

// A callback from a downstream system (the provider, logistics, an engineer, a partner). Sent to a
// line while it's provisioning, and to its ceaseLine Workflow while that waits on the provider.
export const lineEventSignal = defineSignal<[{ type: EventName }]>('lineEvent');

// From the portfolio: a new order replaces this line (an upgrade or crossgrade).
export const replaceLineSignal = defineSignal<[{ byLineId: string; bundleBehaviour: BundleBehaviour }]>('replaceLine');

// From the portfolio: cancel this line before it activates. A line that has already activated
// ignores it; the portfolio ceases a live line with a ceaseLine Workflow instead.
export const cancelLineSignal = defineSignal<[{ reason: string }]>('cancelLine');

// From the portfolio, to a line that replaces another: the old line has let go.
export const releaseLineSignal = defineSignal<[Release]>('releaseLine');

// From an operator: move this running line onto another version of its route, at its next gate.
// An Update so the console hears straight away whether the line can move (its validator) and
// whether that version exists (the handler loads it).
export const changeRouteUpdate = defineUpdate<{ version: number }, [{ version: number; compensate: boolean }]>('changeRoute');

// --- All three ----------------------------------------------------------------------------------

// The Workflow's history, for the console's detail views. The API asks only when the memo's `rev`
// has changed, so an open console doesn't Query on every refresh.
export const historyQuery = defineQuery<TimelineEntry[]>('history');
