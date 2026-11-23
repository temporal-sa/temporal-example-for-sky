import { useEffect, useRef, useState } from 'react';
import { type DownstreamState, type Mode, PRODUCTS, SYSTEMS, type System, api } from './api';
import { ROW_LABELS, ROW_STATUS, StatusBadge, time } from './status';

interface Props {
  open: boolean;
  state: DownstreamState | null;
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'healthy', label: 'Healthy', hint: 'Answers normally' },
  { mode: 'slow', label: 'Slow', hint: 'Answers after 3 seconds' },
  { mode: 'failing', label: 'Failing', hint: 'Returns HTTP 503' },
];

const SYSTEM_NAMES: Record<System, string> = {
  catalogue: 'Product catalogue',
  portfolio: 'Portfolio',
  provider: 'SNS/OSS provider',
  logistics: 'Logistics',
  engineering: 'Field engineering',
  partner: 'Partner (Netflix)',
  billing: 'Billing',
};

// The sandbox's simulated systems: switch each one's health, and see what each one holds.
export function DownstreamDrawer({ open, state, onClose, onChanged, onError }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [modes, setModes] = useState(state?.modes);
  const [resetting, setResetting] = useState(false);

  useEffect(() => setModes(state?.modes), [state?.modes]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const setMode = async (system: System, mode: Mode) => {
    const previous = modes;
    // Apply at once; the server almost never refuses this, and the next refresh reconciles.
    setModes((current) => current && { ...current, [system]: mode });
    try {
      setModes((await api.setMode(system, mode)).modes);
      onChanged();
    } catch (err) {
      setModes(previous);
      onError(`Couldn't change ${SYSTEM_NAMES[system]}: ${(err as Error).message}`);
    }
  };

  const reset = async () => {
    if (!window.confirm('Delete every customer and line, reset the routes to v1, and reset the simulated systems?')) return;
    setResetting(true);
    try {
      await api.reset();
      location.hash = '';
      onChanged();
    } catch (err) {
      onError(`Reset failed: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  };

  const jobs = state ? [...state.consignments.map((j) => ({ ...j, system: 'Logistics' })), ...state.visits.map((j) => ({ ...j, system: 'Field engineering' })), ...state.partnerAccounts.map((j) => ({ ...j, system: 'Partner' }))] : [];

  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="drawer-heading" onClose={onClose} onCancel={onClose}>
      <div className="drawer-head">
        <div>
          <p className="eyebrow">Sandbox</p>
          <h2 id="drawer-heading">Downstream systems</h2>
        </div>
        <button type="button" className="button ghost" onClick={onClose} aria-label="Close downstream systems">
          Close
        </button>
      </div>

      {!state || !modes ? (
        <p className="subtle pad">The simulated systems aren't reachable.</p>
      ) : (
        <div className="drawer-body">
          <section className="card" aria-labelledby="health-heading">
            <h3 id="health-heading">Health</h3>
            <p className="small subtle">Slow answers after 3 seconds. Failing returns HTTP 503, which Temporal retries.</p>
            <ul className="systems">
              {SYSTEMS.map((system) => (
                <li key={system}>
                  <span>{SYSTEM_NAMES[system]}</span>
                  <div className="segmented" role="radiogroup" aria-label={`${SYSTEM_NAMES[system]} health`}>
                    {MODES.map(({ mode, label, hint }) => (
                      <button key={mode} type="button" role="radio" aria-checked={modes[system] === mode} title={hint} onClick={() => setMode(system, mode)}>
                        {label}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <Table
            title="Portfolio rows"
            empty="No rows yet."
            head={['Line', 'Product', 'Status', 'Last change']}
            rows={state.portfolioRows.map((row) => [
              <span className="mono">{row.lineId}</span>,
              PRODUCTS[row.product]?.short ?? row.product,
              <StatusBadge status={ROW_STATUS[row.status]} label={ROW_LABELS[row.status]} code={row.status} />,
              <span className="small">{row.history.at(-1)?.text}</span>,
            ])}
          />

          <Table
            title="Billing subscriptions"
            empty="Nobody is being billed."
            head={['Line', 'Product', 'Billing']}
            rows={state.subscriptions.map((s) => [
              <span className="mono">{s.lineId}</span>,
              PRODUCTS[s.product]?.short ?? s.product,
              <span className="small">{s.until ? `Stopped ${time(s.until)} (from ${time(s.since)})` : `Since ${time(s.since)}`}</span>,
            ])}
          />

          <Table
            title="Provider orders"
            empty="No provider orders yet."
            head={['Reference', 'Line', 'Type', 'State']}
            rows={state.providerOrders.map((order) => [
              <span className="mono">{order.providerOrderRef}</span>,
              <span className="mono">{order.lineId}</span>,
              <span className="small">
                {order.type}
                {order.migrateFrom && ` from ${order.migrateFrom}`}
              </span>,
              <span className="small">{order.state}</span>,
            ])}
          />

          <Table
            title="Kit, engineer visits and partner accounts"
            empty="Nothing dispatched or booked yet."
            head={['Reference', 'Line', 'What', 'State']}
            rows={jobs.map((job) => [
              <span className="mono">{job.ref}</span>,
              <span className="mono">{job.lineId}</span>,
              <span className="small">
                {job.system}: {job.what}
              </span>,
              <span className="small">{job.state}</span>,
            ])}
          />

          <section className="card" aria-labelledby="reset-heading">
            <h3 id="reset-heading">Reset the sandbox</h3>
            <p className="small subtle">Deletes every portfolio and line execution, puts each product back on its v1 route, and clears the simulated systems.</p>
            <div className="button-row">
              <button type="button" className="button secondary" onClick={reset} disabled={resetting}>
                {resetting ? 'Resetting…' : 'Reset sandbox'}
              </button>
            </div>
          </section>
        </div>
      )}
    </dialog>
  );
}

function Table({ title, empty, head, rows }: { title: string; empty: string; head: string[]; rows: React.ReactNode[][] }) {
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="subtle small">{empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="table compact">
            <thead>
              <tr>
                {head.map((h) => (
                  <th scope="col" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, index) => (
                <tr key={index}>
                  {cells.map((cell, i) => (
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
