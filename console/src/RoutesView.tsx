import { useState } from 'react';
import { PRODUCTS, PRODUCT_CODES, type ProductCode, type Route, api } from './api';
import { RouteDiagram, type RouteEdits } from './RouteDiagram';
import { time } from './status';

interface Props {
  routes: Route[];
  product: ProductCode;
  onSelectProduct: (product: ProductCode) => void;
  onPublished: () => void;
}

// The product catalogue's routes: which steps each product goes through. A published version is
// used by lines that start from then on; lines already running keep the version they started with.
export function RoutesView({ routes, product, onSelectProduct, onPublished }: Props) {
  const versions = routes.filter((r) => r.product === product);
  const current = versions.at(-1);
  const [viewing, setViewing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Route | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? versions.find((r) => r.version === viewing) ?? current;

  const choose = (next: ProductCode) => {
    setDraft(null);
    setViewing(null);
    setProblem(null);
    onSelectProduct(next);
  };

  const edit = (change: (route: Route) => void) =>
    setDraft((before) => {
      if (!before) return before;
      const next = structuredClone(before);
      change(next);
      return next;
    });

  const edits: RouteEdits = {
    removeStep: (stage, step) => edit((r) => void r.stages[stage].steps.splice(step, 1)),
    addStep: (stage, step) => edit((r) => void r.stages[stage].steps.push(step)),
    renameStage: (stage, name) => edit((r) => void (r.stages[stage].name = name)),
    removeStage: (stage) => edit((r) => void r.stages.splice(stage, 1)),
  };

  const publish = async () => {
    if (!draft) return;
    setPublishing(true);
    setProblem(null);
    try {
      const published = await api.publishRoute(draft);
      setDraft(null);
      setViewing(published.version);
      onPublished();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <main className="workspace routes-workspace">
      <section className="panel" aria-labelledby="products-heading">
        <div className="panel-head">
          <h2 id="products-heading">Products</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Product</th>
              <th scope="col">Current</th>
            </tr>
          </thead>
          <tbody>
            {PRODUCT_CODES.map((code) => {
              const latest = routes.filter((r) => r.product === code).at(-1);
              return (
                <tr key={code} aria-selected={code === product} onClick={() => choose(code)}>
                  <td>
                    <a href={`#/routes/${code}`} onClick={(e) => e.stopPropagation()}>
                      {PRODUCTS[code].name}
                    </a>
                  </td>
                  <td className="mono">{latest ? `v${latest.version}` : '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel detail" aria-labelledby="route-heading">
        {!shown ? (
          <div className="empty">
            <h2>No routes loaded</h2>
            <p className="subtle">The product catalogue isn't reachable.</p>
          </div>
        ) : (
          <div className="detail-body">
            <div className="detail-head">
              <div>
                <p className="eyebrow">Route</p>
                <h2 id="route-heading">
                  {PRODUCTS[product].name} {draft ? `· draft v${(current?.version ?? 0) + 1}` : `v${shown.version}`}
                </h2>
                {!draft && (
                  <p className="subtle small">
                    {shown.version === current?.version ? 'Current: new lines start on this version.' : 'An earlier version. Lines that started on it keep using it.'}
                    {shown.publishedAt && ` Published ${time(shown.publishedAt)}.`}
                  </p>
                )}
              </div>
              {!draft && (
                <div className="segmented" role="radiogroup" aria-label="Version">
                  {versions.map((r) => (
                    <button key={r.version} type="button" role="radio" aria-checked={r.version === shown.version} onClick={() => setViewing(r.version)}>
                      v{r.version}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {draft ? (
              <label className="field">
                <span className="small">What this version changes</span>
                <input value={draft.description} onChange={(e) => edit((r) => void (r.description = e.target.value))} />
              </label>
            ) : (
              <p>{shown.description}</p>
            )}

            <RouteDiagram route={shown} edits={draft ? edits : undefined} />

            {draft && (
              <button type="button" className="button secondary small add-stage" onClick={() => edit((r) => void r.stages.push({ name: `Stage ${r.stages.length + 1}`, steps: [] }))}>
                Add stage
              </button>
            )}

            {problem && (
              <div className="callout" data-status="failed" role="alert">
                <strong>The catalogue didn't publish this version.</strong>
                <span className="small">{problem}</span>
              </div>
            )}

            <div className="button-row">
              {draft ? (
                <>
                  <button type="button" className="button primary" onClick={publish} disabled={publishing}>
                    {publishing ? 'Publishing…' : `Publish v${(current?.version ?? 0) + 1}`}
                  </button>
                  <button type="button" className="button ghost" onClick={() => setDraft(null)} disabled={publishing}>
                    Discard draft
                  </button>
                </>
              ) : (
                current && (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => {
                      setProblem(null);
                      setDraft({ ...structuredClone(current), description: '' });
                    }}
                  >
                    Draft a new version from v{current.version}
                  </button>
                )
              )}
            </div>

            <details className="disclosure">
              <summary>As stored in the catalogue (JSON)</summary>
              <pre className="json">{JSON.stringify({ description: shown.description, stages: shown.stages }, null, 2)}</pre>
            </details>
          </div>
        )}
      </section>
    </main>
  );
}
