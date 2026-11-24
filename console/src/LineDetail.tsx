import { useState } from 'react';
import {
  type BundleBehaviour,
  EVENTS,
  EVENT_NAMES,
  type EventName,
  type LineDetail as Detail,
  PRODUCTS,
  type PortfolioLine,
  type ProductCode,
  type Route,
  type RowStatus,
  api,
} from './api';
import { RouteDiagram } from './RouteDiagram';
import { ROW_LABELS, STEP_STATUS, StatusBadge, billingText, lineStatus, time } from './status';

interface Props {
  line: Detail;
  lines: PortfolioLine[];
  routes: Route[];
  onSelectLine: (lineId: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

const ACTIVITY_SYSTEMS: Record<string, string> = {
  loadRoute: 'Product catalogue',
  setPortfolioRowStatus: 'Portfolio',
  logPortfolioRowEvent: 'Portfolio',
  submitVoiceAndDataOrder: 'SNS/OSS provider',
  ceaseVoiceAndDataOrder: 'SNS/OSS provider',
  dispatchKit: 'Logistics',
  recallKit: 'Logistics',
  bookEngineerVisit: 'Field engineering',
  cancelEngineerVisit: 'Field engineering',
  activatePartnerAccount: 'Partner',
  deactivatePartnerAccount: 'Partner',
  startBilling: 'Billing',
  stopBilling: 'Billing',
};

export function LineDetail({ line, lines, routes, onSelectLine, onChanged, onError }: Props) {
  const { status, label } = lineStatus(line, line.pendingWork);
  const open = line.status === 'PROVISIONING' || line.status === 'ACTIVE';
  const portfolioLine = lines.find((l) => l.lineId === line.lineId);
  // The same rules the portfolio's validator applies; it has the final say.
  const changeable =
    open && !line.cease && !line.replacedBy && !portfolioLine?.ceaseRequested && !portfolioLine?.ceaseStarted && !(line.replaces && line.status === 'PROVISIONING');
  // Callbacks go to whichever Workflow is running for the line: the line while it's provisioning,
  // then its cease.
  const listening = line.status === 'PROVISIONING' || line.cease?.status === 'CEASING';

  return (
    <div className="line-detail">
      <div className="detail-head">
        <div>
          <p className="eyebrow">Product line</p>
          <h3 className="line-title">
            {PRODUCTS[line.product].name} <span className="mono subtle">{line.lineId}</span>
          </h3>
          <p className="subtle small">
            Route v{line.routeVersion ?? '…'} · order <span className="mono">{line.orderId}</span>
            {line.providerOrderRef && (
              <>
                {' '}
                · provider ref <span className="mono">{line.providerOrderRef}</span>
              </>
            )}{' '}
            · {billingText(line.billing)}
          </p>
        </div>
        <div className="detail-head-side">
          <StatusBadge status={status} label={label} code={line.rowStatus} />
          <a className="link small" href={line.temporalUrl} target="_blank" rel="noreferrer">
            Open line in Temporal UI ↗
          </a>
          {line.ceaseTemporalUrl && (
            <a className="link small" href={line.ceaseTemporalUrl} target="_blank" rel="noreferrer">
              Open cease in Temporal UI ↗
            </a>
          )}
        </div>
      </div>

      <Lifecycle line={line} />

      {(line.replaces || line.replacedBy) && (
        <div className="links">
          {line.replaces && (
            <span>
              Replaces{' '}
              <button type="button" className="link mono" onClick={() => onSelectLine(line.replaces!)}>
                {line.replaces}
              </button>
            </span>
          )}
          {line.replacedBy && (
            <span>
              Replaced by{' '}
              <button type="button" className="link mono" onClick={() => onSelectLine(line.replacedBy!)}>
                {line.replacedBy}
              </button>
            </span>
          )}
        </div>
      )}

      {line.pendingWork
        .filter((work) => work.attempt > 1)
        .map((work) => (
          <div className="callout" data-status="retrying" key={work.activity} role="status">
            <strong>
              {ACTIVITY_SYSTEMS[work.activity] ?? work.activity} call failed. Temporal is retrying it (attempt {work.attempt}
              {work.nextAttemptAt && `, next try ${time(work.nextAttemptAt)}`}).
            </strong>
            {work.lastFailure && <span className="mono small">{work.lastFailure}</span>}
            <span className="small">The line keeps its place and carries on as soon as the call succeeds.</span>
          </div>
        ))}

      <div className="now">
        <span className="eyebrow">Now</span>
        <p>{line.phase}</p>
        {line.status === 'ACTIVE' && !line.cease && (
          <p className="small subtle">
            Provisioning is done, so this line's Workflow has completed. The portfolio holds the live line: a cease or an upgrade starts new
            Workflows from there.
          </p>
        )}
      </div>

      {line.cease && <Cease cease={line.cease} />}

      {line.route ? (
        <section aria-labelledby="route-progress-heading">
          <h3 id="route-progress-heading">
            Route v{line.routeVersion}{' '}
            <a className="link small" href={`#/routes/${line.product}`}>
              see all versions
            </a>
          </h3>
          <RouteDiagram route={line.route} states={line.steps} />
          {line.retired.length > 0 && (
            <ul className="retired">
              {line.retired.map((step) => (
                <li key={step.id}>
                  <span className="small">
                    From v{step.fromVersion}: <strong>{step.name}</strong>
                  </span>{' '}
                  <StatusBadge {...STEP_STATUS[step.state]} label={step.state === 'done' || step.state === 'waiting' ? 'Kept as it was' : STEP_STATUS[step.state].label} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <p className="subtle">Waiting for a Worker to load the route.</p>
      )}

      {listening && <Callbacks line={line} onChanged={onChanged} onError={onError} />}

      {line.status === 'PROVISIONING' && line.route && !line.replacedBy && !portfolioLine?.ceaseRequested && line.rowStatus !== 'PAX' && <MoveRoute line={line} routes={routes} onChanged={onChanged} />}

      {changeable && <CustomerChange line={line} onChanged={onChanged} onSelectLine={onSelectLine} />}

      <section aria-labelledby="line-history-heading">
        <h3 id="line-history-heading">History</h3>
        <HistoryNote current={line.historyCurrent} empty={line.timeline.length === 0} />
        <Timeline entries={line.timeline} />
      </section>
    </div>
  );
}

// History comes from a Query, which needs a Worker. Everything else on the page comes from the
// memo and keeps updating while the Worker is down.
export function HistoryNote({ current, empty }: { current: boolean; empty: boolean }) {
  if (current) return null;
  return (
    <p className="small subtle" role="status">
      {empty ? 'History needs a running Worker to answer its Query. It appears once one is back.' : 'No Worker is answering, so this is the history as of the last time one did.'}
    </p>
  );
}

// The cease of a live line: its own Workflow, started by the portfolio after the line's has ended.
function Cease({ cease }: { cease: NonNullable<Detail['cease']> }) {
  return (
    <section className="card" aria-labelledby="cease-heading">
      <div className="card-head">
        <h3 id="cease-heading">Cease</h3>
        <span className="subtle small">A ceaseLine Workflow, started by the portfolio: {cease.reason}</span>
      </div>
      {cease.replacedBy ? (
        <p className="small">The service migrated to {cease.replacedBy}, so billing stops and nothing is undone downstream.</p>
      ) : cease.steps.length === 0 ? (
        <p className="small">Nothing to undo; billing stops.</p>
      ) : (
        <ul className="cease-steps">
          {cease.steps.map((step) => (
            <li key={step.stepId}>
              <span className="small">Undo {step.name}</span> <StatusBadge {...STEP_STATUS[step.state]} label={step.state === 'pending' ? 'Not started' : STEP_STATUS[step.state].label} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Timeline({ entries }: { entries: Detail['timeline'] }) {
  if (entries.length === 0) return <p className="subtle">Nothing yet.</p>;
  return (
    <ol className="timeline">
      {[...entries].reverse().map((entry, index) => (
        <li key={index} data-tone={entry.tone}>
          <span className="mono subtle">{time(entry.at)}</span>
          <span>
            {entry.tone === 'ignored' && <span className="tag">Logged only</span>}
            {entry.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

// The Portfolio row's path through the state model, with the current state marked.
function Lifecycle({ line }: { line: Detail }) {
  const cancelPath = line.rowStatus === 'PAX' || line.rowStatus === 'CN';
  const path: RowStatus[] = cancelPath ? ['BEGIN', 'RQ', 'AP', 'PAX', 'CN'] : ['BEGIN', 'RQ', 'AP', 'AC', 'CE'];
  const current = path.indexOf(line.rowStatus);
  const settled = ['CN', 'AC', 'CE'].includes(line.rowStatus) && line.awaiting.length === 0;
  return (
    <ol className="lifecycle" aria-label="Portfolio row lifecycle">
      {path.map((state, index) => {
        const here = index === current;
        const done = index < current || (here && settled);
        return (
          <li key={state} data-state={done ? 'done' : here ? 'current' : 'todo'} aria-current={here ? 'step' : undefined}>
            <span className="mono">{state}</span>
            <span className="small">{here && line.status === 'MIGRATED' ? 'Stays AP (migrated)' : ROW_LABELS[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Stand-ins for downstream systems calling fulfilment back. The events the line is waiting for
// come first; any other can still be sent, to show the line logging one that doesn't apply.
function Callbacks({ line, onChanged, onError }: { line: Detail; onChanged: () => void; onError: (m: string) => void }) {
  const [sending, setSending] = useState<EventName | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const others = EVENT_NAMES.filter((event) => !line.awaiting.includes(event));

  const send = async (type: EventName) => {
    setSending(type);
    setSent(null);
    try {
      await api.sendEvent(line.lineId, type);
      setSent(`${type} sent`);
      onChanged();
    } catch (err) {
      onError(`Couldn't send ${type}: ${(err as Error).message}`);
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="card" aria-labelledby="callbacks-heading">
      <div className="card-head">
        <h3 id="callbacks-heading">Callbacks</h3>
        <span className="subtle small">Simulates downstream systems calling fulfilment back</span>
      </div>
      {line.awaiting.length > 0 ? (
        <div className="button-row">
          {line.awaiting.map((event) => (
            <button key={event} type="button" className="button primary" disabled={sending !== null} onClick={() => send(event)}>
              {sending === event ? 'Sending…' : `Send ${event}`}
              <span className="button-note">{EVENTS[event]}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="subtle small">The line isn't waiting on anyone right now.</p>
      )}
      <details className="disclosure">
        <summary>Send a different event</summary>
        <div className="button-row">
          {others.map((event) => (
            <button key={event} type="button" className="button secondary small" disabled={sending !== null} onClick={() => send(event)}>
              {sending === event ? 'Sending…' : event}
            </button>
          ))}
        </div>
      </details>
      <p className="small subtle" role="status">
        {sent ?? ''}
      </p>
    </section>
  );
}

// Moves the running line onto another version of its route, at its next gate.
function MoveRoute({ line, routes, onChanged }: { line: Detail; routes: Route[]; onChanged: () => void }) {
  const others = routes.filter((r) => r.product === line.product && r.version !== line.routeVersion);
  const [version, setVersion] = useState<number | undefined>(others.at(-1)?.version);
  const [compensate, setCompensate] = useState(false);
  const [moving, setMoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (others.length === 0) return null;

  const target = others.find((r) => r.version === version) ?? others.at(-1)!;
  const ids = (route: Route) => route.stages.flatMap((stage) => stage.steps);
  const current = ids(line.route!);
  const removed = current.filter((step) => !ids(target).some((s) => s.id === step.id));
  const added = ids(target).filter((step) => !current.some((s) => s.id === step.id));

  const move = async () => {
    setMoving(true);
    setRefusal(null);
    try {
      await api.changeRoute(line.lineId, target.version, compensate);
      onChanged();
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setMoving(false);
    }
  };

  return (
    <section className="card" aria-labelledby="move-heading">
      <div className="card-head">
        <h3 id="move-heading">Route version</h3>
        <span className="subtle small">This line stays on v{line.routeVersion} unless it's moved</span>
      </div>
      <div className="move-route">
        <label>
          <span className="small">Move to</span>
          <select value={target.version} onChange={(e) => setVersion(Number(e.target.value))}>
            {others.map((r) => (
              <option key={r.version} value={r.version}>
                v{r.version}
              </option>
            ))}
          </select>
        </label>
        <p className="small">
          {added.length > 0 && <>Adds {added.map((s) => s.name).join(', ')}. </>}
          {removed.length > 0 && <>Removes {removed.map((s) => s.name).join(', ')}. </>}
          {added.length + removed.length === 0 && 'Same steps; their settings may differ. '}
          Steps both versions share keep their progress.
        </p>
        {removed.some((step) => step.undo && line.steps[step.id] !== 'pending') && (
          <label className="check">
            <input type="checkbox" checked={compensate} onChange={(e) => setCompensate(e.target.checked)} />
            <span className="small">Undo what the removed steps already did (compensate)</span>
          </label>
        )}
      </div>
      {refusal && (
        <p className="small field-error" role="alert">
          {refusal}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="button secondary" onClick={move} disabled={moving}>
          {moving ? 'Moving…' : `Move to v${target.version} at the next gate`}
        </button>
      </div>
    </section>
  );
}

// Customer changes on this line. Each one is an order placed on the customer's portfolio, which
// decides whether it fits what the customer holds now.
function CustomerChange({ line, onChanged, onSelectLine }: { line: Detail; onChanged: () => void; onSelectLine: (id: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'upgrade' | 'cease'>('idle');
  const [behaviour, setBehaviour] = useState<BundleBehaviour>('REVERT');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const upgradeTo: ProductCode | undefined = PRODUCTS[line.product].broadband
    ? line.product === 'BROADBAND_SUPERFAST'
      ? 'BB_FIBRE_UNLIMITED_PRO'
      : 'BROADBAND_SUPERFAST'
    : undefined;
  const active = line.status === 'ACTIVE';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setRefusal(null);
    try {
      const portfolio =
        mode === 'upgrade'
          ? await api.placeOrder(line.accountId, [{ type: 'ADD', product: upgradeTo!, replaces: line.lineId }], behaviour)
          : await api.placeOrder(line.accountId, [{ type: 'CEASE', lineId: line.lineId }]);
      setMode('idle');
      if (mode === 'upgrade') onSelectLine(portfolio.orders.at(-1)!.lineIds[0]);
      else onChanged();
    } catch (err) {
      setRefusal((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-labelledby="change-heading">
      <div className="card-head">
        <h3 id="change-heading">Customer change</h3>
        <span className="subtle small">Placed as a new order on the customer's portfolio</span>
      </div>
      {mode === 'idle' && (
        <div className="button-row">
          {upgradeTo && (
            <button type="button" className="button secondary" onClick={() => setMode('upgrade')}>
              Upgrade to {PRODUCTS[upgradeTo].short}
            </button>
          )}
          <button type="button" className="button secondary" onClick={() => setMode('cease')}>
            {active ? 'Cease this line' : 'Cancel this line'}
          </button>
        </div>
      )}
      {mode === 'upgrade' && (
        <fieldset className="choices">
          <legend className="small">
            {active
              ? 'This line is active: the upgrade crossgrades the live service. This line bills until the upgrade activates; then the portfolio ceases it.'
              : 'What happens to this line, which is still being provisioned:'}
          </legend>
          {!active && (
            <>
              <label className="choice">
                <input type="radio" name="behaviour" checked={behaviour === 'REVERT'} onChange={() => setBehaviour('REVERT')} />
                <span>
                  <strong>REVERT</strong>
                  <span className="subtle small">Undo its steps (cease at the provider, recall kit): AP → PAX → CN. Then provide the upgrade.</span>
                </span>
              </label>
              <label className="choice">
                <input type="radio" name="behaviour" checked={behaviour === 'PROVIDE'} onChange={() => setBehaviour('PROVIDE')} />
                <span>
                  <strong>PROVIDE (migrate)</strong>
                  <span className="subtle small">One migrate order at the provider takes over its order. Its row gets a CROSSGRADE cease and stays AP.</span>
                </span>
              </label>
            </>
          )}
        </fieldset>
      )}
      {mode === 'cease' && (
        <p className="small">
          {active
            ? 'The portfolio starts a cease Workflow: billing stops, then each completed step is undone (AC → CE).'
            : "Each completed step is undone (AP → PAX → CN). The customer's other lines carry on."}
        </p>
      )}
      {refusal && (
        <p className="small field-error" role="alert">
          The portfolio refused the order: {refusal}
        </p>
      )}
      {mode !== 'idle' && (
        <div className="button-row">
          <button type="submit" className="button primary" disabled={submitting}>
            {submitting ? 'Placing…' : mode === 'upgrade' ? `Place upgrade order` : active ? 'Place cease order' : 'Place cancellation order'}
          </button>
          <button type="button" className="button ghost" onClick={() => setMode('idle')} disabled={submitting}>
            Back
          </button>
        </div>
      )}
    </form>
  );
}
