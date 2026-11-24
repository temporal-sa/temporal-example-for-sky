import type { LineListItem, PendingWork, RowStatus, StepState } from './api';

// The status vocabulary: colour says whether work is moving, held, done or broken. Every badge
// also carries a text label, so colour never carries the meaning alone.
export type Status = 'pending' | 'active' | 'waiting' | 'retrying' | 'completed' | 'failed' | 'skipped';

export const ROW_LABELS: Record<RowStatus, string> = {
  BEGIN: 'New',
  RQ: 'Requested',
  AP: 'Accepted, not active',
  PAX: 'Cancelling',
  CN: 'Cancelled',
  AC: 'Active',
  CE: 'Ceased',
};

export const ROW_STATUS: Record<RowStatus, Status> = { BEGIN: 'pending', RQ: 'active', AP: 'waiting', PAX: 'active', CN: 'skipped', AC: 'completed', CE: 'skipped' };

export const STEP_STATUS: Record<StepState, { status: Status; label: string }> = {
  pending: { status: 'pending', label: 'Not started' },
  running: { status: 'active', label: 'Running' },
  waiting: { status: 'waiting', label: 'Waiting' },
  done: { status: 'completed', label: 'Done' },
  undoing: { status: 'active', label: 'Undoing' },
  undone: { status: 'skipped', label: 'Undone' },
  dropped: { status: 'skipped', label: 'Not needed' },
};

export function lineStatus(line: Pick<LineListItem, 'status' | 'phase' | 'rowStatus' | 'awaiting' | 'replacedBy'> & { cease: { status: string } | null }, pending: PendingWork[] = []): { status: Status; label: string } {
  if (pending.some((work) => work.attempt > 1)) return { status: 'retrying', label: 'Retrying' };
  switch (line.status) {
    case 'CANCELLED':
      return { status: 'skipped', label: 'Cancelled' };
    case 'MIGRATED':
      return { status: 'skipped', label: 'Migrated' };
    case 'CEASED':
      return { status: 'skipped', label: 'Ceased' };
    case 'ACTIVE':
      if (line.cease) return { status: line.awaiting.length > 0 ? 'waiting' : 'active', label: 'Ceasing' };
      return { status: 'completed', label: line.replacedBy ? 'Active, being replaced' : 'Active' };
    case 'PROVISIONING':
      if (line.phase.startsWith('Held')) return { status: 'waiting', label: 'Held for old line' };
      if (line.rowStatus === 'PAX' || line.phase.startsWith('Cancelling')) return { status: line.awaiting.length ? 'waiting' : 'active', label: 'Cancelling' };
      if (line.awaiting.length > 0) return { status: 'waiting', label: 'Waiting' };
      return { status: 'active', label: 'In progress' };
  }
}

export function StatusBadge({ status, label, code }: { status: Status; label: string; code?: string }) {
  return (
    <span className="badge" data-status={status}>
      <span className="dot" aria-hidden="true" />
      {code && <span className="badge-code">{code}</span>}
      {label}
    </span>
  );
}

export function time(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function billingText(billing: { since?: string; until?: string }): string {
  if (!billing.since) return 'Not billed';
  if (billing.until) return `Billed ${time(billing.since)}–${time(billing.until)}`;
  return `Billing since ${time(billing.since)}`;
}
