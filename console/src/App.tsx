import { useCallback, useEffect, useRef, useState } from 'react';
import { type ConsoleData, type CustomerSummary, PRODUCTS, PRODUCT_CODES, type ProductCode, api } from './api';
import { CustomerPanel } from './CustomerPanel';
import { DownstreamDrawer } from './DownstreamDrawer';
import { NewOrderDialog } from './NewOrderDialog';
import { RoutesView } from './RoutesView';
import { ROW_STATUS, StatusBadge, time } from './status';

const REFRESH_MS = 1_500;

type Location = { view: 'customers'; account?: string; line?: string } | { view: 'routes'; product: ProductCode };

// #/customers/ACC-123456/lines/ORD-ABC123-1, or #/routes/SKY_TV
function readHash(): Location {
  const routes = location.hash.match(/^#\/routes(?:\/([A-Z_]+))?$/);
  if (routes) {
    const product = PRODUCT_CODES.find((code) => code === routes[1]) ?? 'BROADBAND_SUPERFAST';
    return { view: 'routes', product };
  }
  const customer = location.hash.match(/^#\/customers\/(ACC-[0-9]{6})(?:\/lines\/(ORD-[0-9A-Z]{6}-[0-9]+))?$/);
  return { view: 'customers', account: customer?.[1], line: customer?.[2] };
}

export function App() {
  const [data, setData] = useState<ConsoleData | null>(null);
  const [where, setWhere] = useState<Location>(readHash);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [offline, setOffline] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [ordering, setOrdering] = useState<{ accountId: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshNow = useRef<() => void>(() => {});
  const account = where.view === 'customers' ? where.account : undefined;
  const line = where.view === 'customers' ? where.line : undefined;

  // One request refreshes the whole screen. A newer request aborts an older one, so a slow
  // response can never overwrite a fresher one.
  useEffect(() => {
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      window.clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      try {
        setData(await api.console({ account, line }, controller.signal));
        setOffline(false);
        setLastRefresh(new Date());
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setOffline(true);
      }
      timer = window.setTimeout(load, REFRESH_MS);
    };
    refreshNow.current = load;
    load();
    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [account, line]);

  useEffect(() => {
    const onHash = () => setWhere(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const selectLine = useCallback((lineId: string) => {
    if (account) location.hash = `#/customers/${account}/lines/${lineId}`;
  }, [account]);

  const modes = data?.downstream?.modes;
  const unhealthy = modes ? Object.entries(modes).filter(([, mode]) => mode !== 'healthy') : [];
  const customer = data?.selected && data.selected.portfolio.accountId === account ? data.selected : null;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Fulfilment</h1>
            <p className="subtle">Customer product orchestration · sandbox</p>
          </div>
        </div>
        <nav className="tabs" aria-label="Views">
          <a href={account ? `#/customers/${account}` : '#/customers'} aria-current={where.view === 'customers' ? 'page' : undefined}>
            Customers
          </a>
          <a href="#/routes" aria-current={where.view === 'routes' ? 'page' : undefined}>
            Product routes
          </a>
        </nav>
        <div className="topbar-actions">
          <Freshness lastRefresh={lastRefresh} offline={offline} />
          <button type="button" className="button secondary" onClick={() => setDrawerOpen(true)} aria-haspopup="dialog">
            Downstream systems
            {unhealthy.length > 0 ? (
              <span className="badge" data-status="retrying">
                <span className="dot" aria-hidden="true" />
                {unhealthy.map(([system, mode]) => `${system} ${mode}`).join(', ')}
              </span>
            ) : (
              modes && (
                <span className="badge" data-status="completed">
                  <span className="dot" aria-hidden="true" />
                  All healthy
                </span>
              )
            )}
          </button>
          <button type="button" className="button primary" onClick={() => setOrdering({ accountId: null })}>
            New order
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice" role="alert">
          <span>{notice}</span>
          <button type="button" className="button ghost small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {where.view === 'routes' ? (
        <RoutesView
          routes={data?.routes ?? []}
          product={where.product}
          onSelectProduct={(product) => (location.hash = `#/routes/${product}`)}
          onPublished={() => refreshNow.current()}
        />
      ) : (
        <main className="workspace">
          <section className="panel" aria-labelledby="customers-heading">
            <div className="panel-head">
              <h2 id="customers-heading">Customers</h2>
              <span className="subtle">{data ? `${data.customers.length} shown` : 'Loading…'}</span>
            </div>
            <CustomersTable customers={data?.customers ?? []} selected={account} />
          </section>

          <section className="panel detail" aria-label="Customer detail">
            {customer ? (
              <CustomerPanel
                customer={customer}
                line={data?.line ?? null}
                routes={data?.routes ?? []}
                onSelectLine={selectLine}
                onAddProducts={() => setOrdering({ accountId: customer.portfolio.accountId })}
                onChanged={() => refreshNow.current()}
                onError={setNotice}
              />
            ) : (
              <div className="empty">
                <h2>{account ? 'Loading customer…' : 'No customer selected'}</h2>
                <p className="subtle">Choose a customer on the left, or place a New order.</p>
              </div>
            )}
          </section>
        </main>
      )}

      <NewOrderDialog
        open={ordering !== null}
        accountId={ordering?.accountId ?? null}
        onClose={() => setOrdering(null)}
        onPlaced={(accountId, firstLineId) => {
          setOrdering(null);
          location.hash = firstLineId ? `#/customers/${accountId}/lines/${firstLineId}` : `#/customers/${accountId}`;
          refreshNow.current();
        }}
      />

      <DownstreamDrawer
        open={drawerOpen}
        state={data?.downstream ?? null}
        onClose={() => setDrawerOpen(false)}
        onChanged={() => refreshNow.current()}
        onError={setNotice}
      />
    </div>
  );
}

function CustomersTable({ customers, selected }: { customers: CustomerSummary[]; selected?: string }) {
  if (customers.length === 0) {
    return <p className="subtle pad">No customers yet. New order places an order for a new customer.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Product lines</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.accountId} aria-selected={c.accountId === selected} onClick={() => (location.hash = `#/customers/${c.accountId}`)}>
              <td>
                <a href={`#/customers/${c.accountId}`} className="mono" onClick={(e) => e.stopPropagation()}>
                  {c.accountId}
                </a>
                <div className="subtle small">Last order {time(c.lastOrderAt)}</div>
              </td>
              <td>
                <div className="line-chips">
                  {c.lines.map((l) => (
                    <StatusBadge key={l.lineId} status={ROW_STATUS[l.rowStatus]} code={l.rowStatus} label={PRODUCTS[l.product].short} />
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Freshness({ lastRefresh, offline }: { lastRefresh: Date | null; offline: boolean }) {
  if (offline) {
    return (
      <span className="badge" data-status="failed" role="status">
        <span className="dot" aria-hidden="true" />
        Can't reach the fulfilment API
      </span>
    );
  }
  return (
    <span className="subtle small" role="status">
      {lastRefresh ? `Live · updated ${lastRefresh.toLocaleTimeString()}` : 'Connecting…'}
    </span>
  );
}
