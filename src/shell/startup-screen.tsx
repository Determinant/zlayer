import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { startupStepPending, type StartupStep } from '../workspace/startup';
import './startup-screen.css';

const STEP_LABELS: Record<StartupStep['state'], string> = {
  waiting: 'Waiting', loading: 'Loading…', rendering: 'Rendering…', ready: 'Ready', cached: 'Cached data', limited: 'Limited data',
  unavailable: 'Unavailable',
};
const OPENING_STEPS: readonly StartupStep[] = [{ id: 'workspace', label: 'Workspace', state: 'loading' }];

export function StartupScreen({ steps = OPENING_STEPS, message, slow = false, onContinue }: {
  steps?: readonly StartupStep[]; message?: string; slow?: boolean; onContinue?: (() => void) | undefined;
}) {
  const required = steps.filter(step => step.blocking !== false);
  const finished = required.filter(step => !startupStepPending(step)).length;
  const opening = steps.some(step => step.id === 'workspace' && startupStepPending(step));
  const loading = required.filter(startupStepPending);
  const pluginsLoading = loading.filter(step => step.id !== 'map' && step.id !== 'workspace');
  const status = message ?? (opening ? 'Opening your workspace…' : pluginsLoading.length
    ? pluginsLoading.length === 1 ? `Loading ${pluginsLoading[0]!.label}…` : `Loading ${pluginsLoading.length} plugins…`
    : loading.length ? 'Preparing your map…' : 'Finishing up…');
  const ref = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const present = () => {
      dialog.showModal();
      title.current?.focus({ preventScroll: true });
    };
    present();
    // A restored full-screen plate can finish its lazy import during startup.
    // Keep the loading screen above late modal restores as they initialize.
    const observer = new MutationObserver(() => {
      const focusedModal = document.activeElement?.closest('dialog:modal');
      if (focusedModal && focusedModal !== dialog) { dialog.close(); present(); }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => { observer.disconnect(); dialog.close(); };
  }, []);
  return createPortal(<dialog ref={ref} className="startup-screen launch-state panel-scroll" aria-labelledby="startup-title"
    aria-describedby="startup-status" onCancel={event => event.preventDefault()}>
    <img className="brand-mark is-loading" src="/icon.svg" alt="" />
    <h1 ref={title} id="startup-title" tabIndex={-1}>ZLayer</h1>
    <p id="startup-status" role="status">{status}</p>
    <div className="startup-progress">
      <progress className="ui-progress" aria-label="Startup progress" max={required.length} value={opening ? undefined : finished}
        aria-valuetext={opening ? 'Opening your workspace' : `${finished} of ${required.length} steps finished`} />
      <ul className="panel-scroll" aria-label="Startup steps" tabIndex={0}>
        {steps.map(step => <li key={step.id} className={`startup-step is-${step.state}`}>
          <span className="startup-step-icon" aria-hidden="true">
            {step.state === 'ready' ? '✓' : step.state === 'limited' || step.state === 'unavailable' ? '!' : ''}
          </span>
          <span>{step.label}</span><span className="startup-step-state">{step.detail ?? STEP_LABELS[step.state]}
            {step.blocking === false && startupStepPending(step) && <small>In background</small>}</span>
        </li>)}
      </ul>
    </div>
    {slow && <div className="startup-recovery">
      <p>{onContinue ? 'Taking longer than usual. You can open the workspace while loading continues.'
        : 'Taking longer than usual. You can reload to try again.'}</p>
      <button className="ui-button" type="button" onClick={onContinue ?? (() => location.reload())}>
        {onContinue ? 'Open workspace' : 'Reload'}
      </button>
    </div>}
  </dialog>, document.body);
}
