import { useId, useRef, type ReactNode } from 'react';
import type { GeoPointFeature, NavigationData, ProcedureCatalog, ProcedureRecord,
  ProcedureResourceRecord, TerminalProceduresResource } from '@zlayer/contracts';
import { findProcedureAirport, procedureSelection, type ProcedureSelection } from '../plates/data';
import type { RouteMapPreview } from './map-preview';
import { usePreviewPanel } from './use-preview-panel';
import './approach-picker.css';

export type ProcedurePickerProps<T> = {
  ident: string;
  feature: GeoPointFeature;
  navigationData?: NavigationData | undefined;
  resource: ProcedureResourceRecord | undefined;
  routeResource?: TerminalProceduresResource | undefined;
  revision?: string | undefined;
  selected: T | undefined;
  onSelect: (selection: T | undefined) => void;
  onClose: (restoreFocus?: boolean) => void;
  onPreviewChange?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
};
export const NO_PREVIEW = () => {};

export function useProcedurePicker(onClose: ProcedurePickerProps<unknown>['onClose'], open = true) {
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const inset = usePreviewPanel(open, dialog, closeButton, onClose);
  return { dialog, closeButton, inset };
}

/** The frame owns dismissal and form isolation; each picker owns its choices. */
export function ProcedurePicker({ panel, ident, title, label, onClose, children }: {
  panel: ReturnType<typeof useProcedurePicker>; ident: string; title: string; label: string;
  onClose: ProcedurePickerProps<unknown>['onClose']; children: ReactNode;
}) {
  const titleId = useId();
  return <div ref={panel.dialog} className="route-preview-panel route-approach-picker" role="dialog" aria-labelledby={titleId}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      // Search/entry selection must not submit the surrounding route editor.
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
    }}>
    <header className="route-approach-heading">
      <div><span className="eyebrow">{ident}</span><h2 id={titleId}>{title}</h2></div>
      <button ref={panel.closeButton} type="button" className="ui-button ui-button--icon" aria-label={`Close ${label} picker`} onClick={() => onClose()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </header>
    {children}
  </div>;
}

export function procedurePickerPlates(catalog: ProcedureCatalog | undefined, feature: GeoPointFeature,
  resource: ProcedureResourceRecord | undefined, onClose: ProcedurePickerProps<unknown>['onClose'],
  onOpenPlate: ProcedurePickerProps<unknown>['onOpenPlate']) {
  const airport = catalog && findProcedureAirport(catalog, feature);
  const openPlate = catalog && airport && resource && onOpenPlate ? (procedure: ProcedureRecord) => {
    const selection = procedureSelection(catalog, airport, procedure, resource.url, window.location.href);
    onClose(false);
    onOpenPlate(selection);
  } : undefined;
  return { airport, openPlate };
}

export function procedurePlateName(name: string): string {
  return name.replace(/\([^)]*\)/g, '').trim().toUpperCase();
}
