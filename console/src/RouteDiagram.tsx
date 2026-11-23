import { useState } from 'react';
import { ACTIONS, EVENTS, EVENT_NAMES, type EventName, type ForwardAction, type Route, type RouteStep, type StepState } from './api';
import { STEP_STATUS, StatusBadge } from './status';

export interface RouteEdits {
  removeStep: (stage: number, step: number) => void;
  addStep: (stage: number, step: RouteStep) => void;
  renameStage: (stage: number, name: string) => void;
  removeStage: (stage: number) => void;
}

// A route drawn as its stages, left to right. Steps in one stage run in parallel; the next stage
// starts when they're all done. With `states`, each step shows how far a line has got with it.
export function RouteDiagram({ route, states, edits }: { route: Route; states?: Record<string, StepState>; edits?: RouteEdits }) {
  return (
    <ol className="route" aria-label={`Route for ${route.product}, version ${route.version}`}>
      {route.stages.map((stage, stageIndex) => (
        <li className="stage" key={stageIndex}>
          <div className="stage-head">
            {edits ? (
              <input
                className="stage-name"
                aria-label={`Stage ${stageIndex + 1} name`}
                value={stage.name}
                onChange={(event) => edits.renameStage(stageIndex, event.target.value)}
              />
            ) : (
              <span className="eyebrow">
                {stageIndex + 1} · {stage.name}
              </span>
            )}
            {stage.steps.length > 1 && <span className="subtle small">in parallel</span>}
            {edits && (
              <button type="button" className="button ghost small" onClick={() => edits.removeStage(stageIndex)} aria-label={`Remove stage ${stage.name}`}>
                Remove stage
              </button>
            )}
          </div>
          <ul className="steps">
            {stage.steps.map((step, stepIndex) => (
              <li className="step" key={step.id} data-state={states?.[step.id]}>
                <StepCard step={step} state={states?.[step.id]} />
                {edits && (
                  <button type="button" className="button ghost small" onClick={() => edits.removeStep(stageIndex, stepIndex)} aria-label={`Remove step ${step.name}`}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {edits && <AddStep route={route} onAdd={(step) => edits.addStep(stageIndex, step)} />}
        </li>
      ))}
    </ol>
  );
}

function StepCard({ step, state }: { step: RouteStep; state?: StepState }) {
  const action = step.action && step.action in ACTIONS ? ACTIONS[step.action as ForwardAction] : undefined;
  const param = action?.param ? step.params?.[action.param] : undefined;
  return (
    <div className="step-body">
      <div className="step-title">
        <strong>{step.name}</strong>
        {state && <StatusBadge {...STEP_STATUS[state]} />}
      </div>
      {action && (
        <span className="small">
          {action.label}
          {param && <> · {param}</>}
        </span>
      )}
      {step.waitFor && (
        <span className="small">
          Gate: <span className="mono">{step.waitFor}</span> <span className="subtle">from {EVENTS[step.waitFor]}</span>
        </span>
      )}
      <span className="subtle small">
        {step.accepted && 'Row moves to AP when accepted. '}
        {step.undo ? `Undone by ${step.undo.action}${step.undo.waitFor ? `, then waits for ${step.undo.waitFor}` : ''}.` : step.action ? 'Nothing to undo.' : ''}
      </span>
    </div>
  );
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function AddStep({ route, onAdd }: { route: Route; onAdd: (step: RouteStep) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [action, setAction] = useState<ForwardAction | ''>('');
  const [param, setParam] = useState('');
  const [waitFor, setWaitFor] = useState<EventName | ''>('');
  const [undoable, setUndoable] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const taken = new Set(route.stages.flatMap((stage) => stage.steps.map((step) => step.id)));
  const id = slug(name);

  if (!open) {
    return (
      <button type="button" className="button secondary small add-step" onClick={() => setOpen(true)}>
        Add step
      </button>
    );
  }

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const spec = action ? ACTIONS[action] : undefined;
    onAdd({
      id,
      name,
      action: action || undefined,
      params: spec?.param && param ? { [spec.param]: param } : undefined,
      waitFor: waitFor || undefined,
      accepted: accepted || undefined,
      // The provider confirms a cease with a callback, so its undo waits for it.
      undo: spec && undoable ? { action: spec.undo, waitFor: action === 'provider.submitVoiceAndData' ? 'CANCEL_ORDER_COMPLETED' : undefined } : undefined,
    });
    setOpen(false);
    setName('');
    setAction('');
    setParam('');
    setWaitFor('');
    setAccepted(false);
  };

  const spec = action ? ACTIONS[action] : undefined;
  return (
    <form className="add-step-form" onSubmit={add}>
      <label>
        <span className="small">Name</span>
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineer brings the hub" />
      </label>
      {id && taken.has(id) && <span className="small field-error">A step called "{id}" already exists in this route.</span>}
      <label>
        <span className="small">Action</span>
        <select value={action} onChange={(e) => setAction(e.target.value as ForwardAction | '')}>
          <option value="">None (a gate only)</option>
          {(Object.keys(ACTIONS) as ForwardAction[]).map((a) => (
            <option key={a} value={a}>
              {ACTIONS[a].label}
            </option>
          ))}
        </select>
      </label>
      {spec?.param && (
        <label>
          <span className="small">{spec.param[0].toUpperCase() + spec.param.slice(1)}</span>
          <input value={param} onChange={(e) => setParam(e.target.value)} />
        </label>
      )}
      <label>
        <span className="small">Gate: wait for</span>
        <select value={waitFor} onChange={(e) => setWaitFor(e.target.value as EventName | '')}>
          <option value="">No gate</option>
          {EVENT_NAMES.filter((e) => e !== 'CANCEL_ORDER_COMPLETED').map((e) => (
            <option key={e} value={e}>
              {e} ({EVENTS[e]})
            </option>
          ))}
        </select>
      </label>
      {spec && (
        <label className="check">
          <input type="checkbox" checked={undoable} onChange={(e) => setUndoable(e.target.checked)} />
          <span className="small">Undo with {spec.undo} if the line is cancelled</span>
        </label>
      )}
      {spec && (
        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span className="small">Moves the row to AP (the order is accepted)</span>
        </label>
      )}
      <div className="button-row">
        <button type="submit" className="button primary small" disabled={!id || taken.has(id) || (!action && !waitFor)}>
          Add
        </button>
        <button type="button" className="button ghost small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
