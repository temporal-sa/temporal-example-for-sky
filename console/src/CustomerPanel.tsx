import { type ConsoleData, PRODUCTS, type Route } from './api';
import { LineDetail, Timeline } from './LineDetail';
import { StatusBadge, billingText, lineStatus, time } from './status';

interface Props {
  customer: NonNullable<ConsoleData['selected']>;
  line: ConsoleData['line'];
  routes: Route[];
  onSelectLine: (lineId: string) => void;
  onAddProducts: () => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

// One customer's portfolio: every product line they hold or are being provisioned with, the orders
// that changed it, and the selected line in detail.
export function CustomerPanel({ customer, line, routes, onSelectLine, onAddProducts, onChanged, onError }: Props) {
  const { portfolio, lines } = customer;
  const retrying = customer.pendingWork.filter((work) => work.attempt > 1);

  return (
    <div className="detail-body">
      <div className="detail-head">
        <div>
          <p className="eyebrow">Customer portfolio</p>
          <h2 className="mono">{portfolio.accountId}</h2>
          <p className="subtle small">
            {lines.length} product {lines.length === 1 ? 'line' : 'lines'} · {portfolio.orders.length} {portfolio.orders.length === 1 ? 'order' : 'orders'}
          </p>
        </div>
        <div className="detail-head-side">
          <button type="button" className="button secondary" onClick={onAddProducts}>
            Add products
          </button>
          <a className="link small" href={customer.temporalUrl} target="_blank" rel="noreferrer">
            Open portfolio in Temporal UI ↗
          </a>
        </div>
      </div>

      {retrying.map((work) => (
        <div className="callout" data-status="retrying" key={work.activity} role="status">
          <strong>
            Portfolio call failed. Temporal is retrying it (attempt {work.attempt}
            {work.nextAttemptAt && `, next try ${time(work.nextAttemptAt)}`}).
          </strong>
          {work.lastFailure && <span className="mono small">{work.lastFailure}</span>}
        </div>
      ))}

      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Product line</th>
              <th scope="col">Route</th>
              <th scope="col">Status</th>
              <th scope="col">Billing</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={4} className="subtle">
                  Waiting for the portfolio to start its lines.
                </td>
              </tr>
            )}
            {lines.map((l) => {
              const { status, label } = lineStatus(l, l.lineId === line?.lineId ? line.pendingWork : []);
              return (
                <tr key={l.lineId} aria-selected={l.lineId === line?.lineId} onClick={() => onSelectLine(l.lineId)}>
                  <td>
                    <a href={`#/customers/${portfolio.accountId}/lines/${l.lineId}`} onClick={(e) => e.stopPropagation()}>
                      {PRODUCTS[l.product].name}
                    </a>
                    <div className="subtle small mono">{l.lineId}</div>
                  </td>
                  <td className="mono">{l.routeVersion ? `v${l.routeVersion}` : '…'}</td>
                  <td>
                    <StatusBadge status={status} label={label} code={l.rowStatus} />
                    <div className="subtle small phase">{l.phase}</div>
                  </td>
                  <td className="small">{billingText(l.billing)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {line && line.accountId === portfolio.accountId ? (
        <LineDetail key={line.lineId} line={line} lines={portfolio.lines} routes={routes} onSelectLine={onSelectLine} onChanged={onChanged} onError={onError} />
      ) : (
        lines.length > 0 && <p className="subtle">Choose a product line to see its route and act on it.</p>
      )}

      <section aria-labelledby="orders-heading">
        <h3 id="orders-heading">Orders</h3>
        <ul className="orders-list">
          {[...portfolio.orders].reverse().map((order) => (
            <li key={order.orderId}>
              <span className="mono">{order.orderId}</span> <span className="subtle small">{time(order.placedAt)}</span>
              <div className="small">
                {order.items.map((item, index) => (
                  <span key={index} className="order-item">
                    <span className="tag" data-action={item.type}>
                      {item.type}
                    </span>
                    {item.type === 'ADD' ? PRODUCTS[item.product].name : item.lineId}
                    {item.type === 'ADD' && item.replaces && <span className="subtle"> replacing {item.replaces} ({order.bundleBehaviour})</span>}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <details className="disclosure">
        <summary>Portfolio history ({portfolio.timeline.length})</summary>
        <Timeline entries={portfolio.timeline} />
      </details>
    </div>
  );
}
