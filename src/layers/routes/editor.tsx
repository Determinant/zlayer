import { RouteEntry, RouteToken } from './editor-tokens';
import { routeEntryComposition } from './composition';
import { expandRouteEntry, routeEntryExpansion } from './expansion';
import { RouteCompositionPanel } from './composition-panel';
import { RadialStationPicker } from './identification-picker';
import { parseRadialDefinition } from '@zlayer/domain';
import { routePointKeys } from './selection';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import type { RouteApproach, RouteTerminal, RouteEntry as DraftEntry, RoutePlan, RouteWaypoint } from '@zlayer/domain';
import type { CatalogResponse, GeoPointFeature, NavigationData, ProcedureResourceRecord } from '@zlayer/contracts';

import { RouteMenu } from './menu';
import { routeTokenStates } from './waypoint-style';
import { backspaceRouteTokenIndex, updateRouteEntry } from './entry';
import type { RouteDraft } from './draft';
import type { RouteLoadStatus } from './use-plan';
import { useEditorGestures } from './use-editor-gestures';
import type { DirectToAction } from './direct-to';
import { DirectToIcon } from './direct-to-icon';
import { RouteApproachPicker } from './approach-picker';
import { RouteTerminalPicker } from './terminal-picker';
import type { RouteMapPreview } from './map-preview';
import type { ProcedureSelection } from '../plates/data';

type RouteEditorProps = {
  plan: RoutePlan;
  catalog: CatalogResponse;
  navigationData?: NavigationData | undefined;
  status: RouteLoadStatus;
  navlogOpen: boolean;
  navlogId: string;
  onToggleNavlog: () => void;
  onUseRoute: (draft: RouteDraft) => void;
  onEditDraft: (edit: (draft: RouteDraft) => RouteDraft) => void;
  onAppendInput: (input: string) => void;
  onInsertInput: (beforeEntryId: string, input: string) => void;
  onReplaceInput: (entryId: string, input: string) => void;
  onRemoveEntry: (entryId: string) => void;
  onMoveEntry: (fromEntryId: string, toEntryId: string) => void;
  onClear: () => void;
  onFit: () => void;
  onDirectTo?: DirectToAction | undefined;
  approachResource?: ProcedureResourceRecord | undefined;
  approachRouteResource?: import('@zlayer/contracts').TerminalProceduresResource | undefined;
  revision?: string | undefined;
  onApproachChange?: ((entry: DraftEntry, approach: RouteApproach | undefined) => void) | undefined;
  onArrivalChange?: ((entry: DraftEntry, arrival: RouteTerminal | undefined) => void) | undefined;
  onDepartureChange?: ((entry: DraftEntry, departure: RouteTerminal | undefined) => void) | undefined;
  onApproachPreview?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
  onIdentify?: ((feature: GeoPointFeature, pointId?: string) => void) | undefined;
  tools: ReactNode;
};

export function RouteEditor({
  plan,
  catalog,
  navigationData,
  status,
  navlogOpen,
  navlogId,
  onToggleNavlog,
  onUseRoute,
  onEditDraft,
  onAppendInput,
  onInsertInput,
  onReplaceInput,
  onRemoveEntry,
  onMoveEntry,
  onClear,
  onFit,
  onDirectTo,
  approachResource,
  approachRouteResource,
  revision: dataRevision,
  onApproachChange,
  onDepartureChange,
  onArrivalChange,
  onApproachPreview,
  onOpenPlate,
  onIdentify,
  tools,
}: RouteEditorProps) {
  const [entry, setEntry] = useState('');
  const revision = plan.revision;
  const { drag, scrolling, menu, setMenu, formRef, editorRef, inputRef, menuButtonRef,
    openMenu, clickToken, captureClick, beginPointer, movePointer, finishPointer } =
    useEditorGestures(revision, onMoveEntry);
  const [inlineEdit, setInlineEdit] = useState<{ entryId: string; mode: 'insert' | 'replace'; originalText: string }>();
  const [approachPicker, setApproachPicker] = useState<{ kind: 'approach' | 'departure' | 'arrival'; entry: DraftEntry; point: RouteWaypoint }>();
  const [compositionEntry, setCompositionEntry] = useState<DraftEntry>();
  const [identificationEntry, setIdentificationEntry] = useState<{ id: string; text: string }>();
  const activeIdentification = identificationEntry && plan.entries.find(value => value.id === identificationEntry.id && value.text === identificationEntry.text &&
    !plan.waypoints.some(point => point.source.entryId === value.id));
  useEffect(() => { if (identificationEntry && !activeIdentification) setIdentificationEntry(undefined); }, [identificationEntry, activeIdentification]);
  const scrollTargetRef = useRef<string | undefined>(undefined);
  const previousEntryCountRef = useRef<number | undefined>(undefined);
  const tokenStates = useMemo(() => routeTokenStates(plan), [plan]);
  const canFit = plan.waypoints.length > 0;
  const directToPoint = menu && plan.waypoints.find(point => point.edit?.entryId === menu.entryId);
  const menuEntry = menu && plan.entries.find(entry => entry.id === menu.entryId);
  const identificationPoint = menuEntry && plan.waypoints.find(point => point.source.entryId === menuEntry.id);
  const menuComposition = menuEntry && routeEntryComposition(plan, menuEntry.id);
  const activeComposition = useMemo(() => compositionEntry && plan.entries.includes(compositionEntry)
    ? routeEntryComposition(plan, compositionEntry.id) : undefined, [plan, compositionEntry]);
  const compositionExpansion = useMemo(() => compositionEntry && activeComposition
    ? routeEntryExpansion(plan, compositionEntry.id) : undefined, [plan, compositionEntry, activeComposition]);
  const expansionProblem = compositionExpansion ? undefined : activeComposition?.procedures.length
    ? 'Procedures cannot be expanded into ordinary waypoints without losing their published paths and restrictions.'
    : 'Expansion requires a complete resolved route item. Review the unresolved sections above.';
  useEffect(() => {
    if (compositionEntry && !activeComposition) setCompositionEntry(undefined);
  }, [compositionEntry, activeComposition]);
  const canChooseApproach = !!onApproachChange && directToPoint?.layer === 'airports';
  const canChooseArrival = !!onArrivalChange && directToPoint?.layer === 'airports';
  const canChooseDeparture = !!onDepartureChange && directToPoint?.layer === 'airports';
  const activePicker = approachPicker && plan.entries.includes(approachPicker.entry) &&
    plan.waypoints.some(point => point.edit?.entryId === approachPicker.entry.id && point.layer === 'airports' &&
      point.feature.id === approachPicker.point.feature.id) ? approachPicker : undefined;

  useEffect(() => {
    if (approachPicker && !activePicker) setApproachPicker(undefined);
  }, [approachPicker, activePicker]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const target = scrollTargetRef.current;
    scrollTargetRef.current = undefined;
    const countChanged = previousEntryCountRef.current !== plan.entries.length;
    previousEntryCountRef.current = plan.entries.length;
    if (target === undefined) {
      if (countChanged) editor.scrollLeft = editor.scrollWidth;
      return;
    }
    [...editor.querySelectorAll<HTMLElement>('[data-route-entry]')].find(element => element.dataset.routeEntry === target)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [plan.entries, inlineEdit]);

  useEffect(() => {
    if (!inlineEdit) return;
    inputRef.current?.focus();
    if (inlineEdit.mode === 'replace') inputRef.current?.select();
    inputRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [inlineEdit]);

  useEffect(() => {
    if (!inlineEdit) return;
    const current = plan.entries.find(entry => entry.id === inlineEdit.entryId);
    if (!current || inlineEdit.mode === 'replace' && current.text !== inlineEdit.originalText) {
      setEntry('');
      setInlineEdit(undefined);
    }
  }, [inlineEdit, plan.entries]);

  const commitEntry = (value = entry) => {
    if (value.trim()) {
      if (inlineEdit) {
        const current = plan.entries.find(entry => entry.id === inlineEdit.entryId);
        if (!current || inlineEdit.mode === 'replace' && current.text !== inlineEdit.originalText) {
          setEntry('');
          setInlineEdit(undefined);
          return;
        }
        scrollTargetRef.current = inlineEdit.entryId;
        if (inlineEdit.mode === 'replace') onReplaceInput(inlineEdit.entryId, value);
        else onInsertInput(inlineEdit.entryId, value);
      } else {
        scrollTargetRef.current = undefined;
        onAppendInput(value);
      }
    }
    setEntry('');
    setInlineEdit(undefined);
  };
  const changeEntry = (value: string) => {
    const update = updateRouteEntry(value);
    if (update.commit !== undefined) commitEntry(update.commit);
    else setEntry(update.value);
  };
  const removeToken = (entryId: string) => {
    onRemoveEntry(entryId);
    setMenu(undefined);
    setInlineEdit(undefined);
    inputRef.current?.focus();
  };
  const editInline = (entryId: string, mode: 'insert' | 'replace') => {
    const current = plan.entries.find(entry => entry.id === entryId);
    if (!current) return;
    setEntry(mode === 'replace' ? current.text : '');
    setMenu(undefined);
    setInlineEdit({ entryId, mode, originalText: current.text });
  };
  const focusToken = (entryId: string) => {
    const token = [...editorRef.current?.querySelectorAll<HTMLElement>('[data-route-entry]') ?? []]
      .find(element => element.dataset.routeEntry === entryId)?.querySelector<HTMLButtonElement>('.route-token');
    token?.focus();
    return !!token;
  };
  const chooseProcedure = (kind: 'approach' | 'departure' | 'arrival', entry: DraftEntry, point: RouteWaypoint) => {
    setMenu(undefined);
    focusToken(entry.id);
    setApproachPicker({ kind, entry, point });
  };
  const finishProcedureChange = (entry: DraftEntry) => {
    setMenu(undefined);
    setApproachPicker(undefined);
    requestAnimationFrame(() => focusToken(entry.id));
  };
  const changeApproach = (entry: DraftEntry, approach: RouteApproach | undefined) => {
    onApproachChange?.(entry, approach);
    finishProcedureChange(entry);
  };
  const changeArrival = (entry: DraftEntry, arrival: RouteTerminal | undefined) => {
    onArrivalChange?.(entry, arrival);
    finishProcedureChange(entry);
  };
  const changeDeparture = (entry: DraftEntry, departure: RouteTerminal | undefined) => {
    onDepartureChange?.(entry, departure);
    finishProcedureChange(entry);
  };

  return (
    <form
      className="route-input"
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        if (entry) commitEntry();
        else if (inlineEdit) commitEntry();
        else if (canFit) onFit();
      }}
    >
      <RouteMenu plan={plan} catalog={catalog} navlogOpen={navlogOpen} navlogId={navlogId} onToggleNavlog={onToggleNavlog}
        onOpen={() => setMenu(undefined)} onLoadRoute={draft => {
        setEntry('');
        setInlineEdit(undefined);
        setMenu(undefined);
        onUseRoute(draft);
      }} onClear={() => {
        setEntry('');
        setMenu(undefined);
        setInlineEdit(undefined);
        onClear();
        requestAnimationFrame(() => inputRef.current?.focus());
      }} />
      <div
        className={`route-editor${scrolling ? ' is-scrolling' : ''}`}
        ref={editorRef}
        title="Drag to scroll · Hold to reorder"
        onPointerDown={(event) => beginPointer(event)}
        onPointerMove={movePointer}
        onPointerUp={(event) => finishPointer(event, false)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
        onClickCapture={captureClick}
        onClick={() => inputRef.current?.focus()}
      >
        <ol className="route-token-list" aria-label="Route entries">
          {plan.entries.map((item, tokenIndex) => {
            const token = item.text;
            const tokenState = tokenStates[tokenIndex]!;
            const { waypoint } = tokenState;
            const ident = waypoint?.ident ?? token;
            const replacing = inlineEdit?.entryId === item.id && inlineEdit.mode === 'replace';
            return (
              <Fragment key={item.id}>
                {inlineEdit?.entryId === item.id && (
                  <li className="route-inline-entry" data-route-entry={replacing ? item.id : undefined}>
                    <RouteEntry
                      ref={inputRef}
                      value={entry}
                      placeholder={replacing ? `Replace ${ident}` : `Add before ${ident}`}
                      ariaLabel={replacing ? `Replace route item ${ident}` : `Add waypoint before ${ident}`}
                      onChange={changeEntry}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          setEntry('');
                          setInlineEdit(undefined);
                        }
                      }}
                      onBlur={() => commitEntry()}
                    />
                  </li>
                )}
                {!replacing && <RouteToken
                  entryId={item.id}
                  ident={ident}
                  approach={item.approach}
                  arrival={item.arrival}
                  onChooseArrival={onArrivalChange && waypoint?.layer === 'airports' ? () => chooseProcedure('arrival', item, waypoint) : undefined}
                  onRemoveArrival={onArrivalChange ? () => changeArrival(item, undefined) : undefined}
                  departure={item.departure}
                  onChooseDeparture={onDepartureChange && waypoint?.layer === 'airports' ? () => chooseProcedure('departure', item, waypoint) : undefined}
                  onRemoveDeparture={onDepartureChange ? () => changeDeparture(item, undefined) : undefined}
                  onChooseApproach={onApproachChange && waypoint?.layer === 'airports' ? () => chooseProcedure('approach', item, waypoint) : undefined}
                  onRemoveApproach={onApproachChange ? () => changeApproach(item, undefined) : undefined}
                  {...tokenState}
                  pending={status === 'loading'}
                  drag={drag}
                  onPointerDown={(event) => beginPointer(event, item.id)}
                  onClick={(event) => clickToken(event, item.id, ident)}
                  onOpenMenu={(element) => openMenu(item.id, ident, element)}
                />}
              </Fragment>
            );
          })}
        </ol>
        {!inlineEdit && (
          <RouteEntry
            ref={inputRef}
            value={entry}
            placeholder={plan.entries.length === 0 ? 'KSFO SSTIK5 SUSEY EBAYE BURGL IRNMN2 KLAX' : ''}
            ariaLabel="Add route waypoint"
            onChange={changeEntry}
            onKeyDown={(event) => {
              const tokenIndex = backspaceRouteTokenIndex(
                event.key,
                entry,
                plan.tokens.length,
              );
              if (tokenIndex !== undefined) {
                event.preventDefault();
                removeToken(plan.entries[tokenIndex]!.id);
              }
              if (event.key === 'Escape') setEntry('');
            }}
            onBlur={() => commitEntry()}
          />
        )}
      </div>

      <div className="route-tools" onPointerDown={() => setMenu(undefined)}>
        {tools}
      </div>

      {menu && (
        <div
          className="route-token-menu"
          style={{ left: menu.left } as CSSProperties}
          role="menu"
          aria-label={`${menu.ident} actions`}
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <span>{menu.ident}</span>
          {menuComposition && menuEntry && <button ref={menuButtonRef} type="button" role="menuitem"
            onClick={() => { setMenu(undefined); setCompositionEntry(menuEntry); }}>Show composition</button>}
          {onDirectTo && directToPoint && <button ref={menuComposition ? undefined : menuButtonRef} type="button" className="route-menu-direct-to" role="menuitem"
            onClick={() => {
              onDirectTo(directToPoint.feature, directToPoint);
              setMenu(undefined);
              setEntry('');
              setInlineEdit(undefined);
              inputRef.current?.focus();
            }}><DirectToIcon />Direct to</button>}
          {canChooseApproach && menuEntry && directToPoint && <button type="button" role="menuitem"
            ref={menuComposition || onDirectTo && directToPoint ? undefined : menuButtonRef}
            onClick={() => chooseProcedure('approach', menuEntry, directToPoint)}>
            {menuEntry.approach ? 'Change approach…' : 'Choose approach…'}
          </button>}
          {menuEntry?.approach && onApproachChange && <button type="button" role="menuitem" className="route-menu-remove"
            onClick={() => changeApproach(menuEntry, undefined)}>Remove approach</button>}
          {canChooseDeparture && menuEntry && directToPoint && <button type="button" role="menuitem"
            ref={menuComposition || onDirectTo && directToPoint || canChooseApproach ? undefined : menuButtonRef}
            onClick={() => chooseProcedure('departure', menuEntry, directToPoint)}>
            {menuEntry.departure ? 'Change SID…' : 'Choose SID…'}
          </button>}
          {canChooseArrival && menuEntry && directToPoint && <button type="button" role="menuitem"
            onClick={() => chooseProcedure('arrival', menuEntry, directToPoint)}>
            {menuEntry.arrival ? 'Change STAR…' : 'Choose STAR…'}
          </button>}
          {menuEntry?.arrival && onArrivalChange && <button type="button" role="menuitem" className="route-menu-remove"
            onClick={() => changeArrival(menuEntry, undefined)}>Remove STAR</button>}
          {menuEntry?.departure && onDepartureChange && <button type="button" role="menuitem" className="route-menu-remove"
            onClick={() => changeDeparture(menuEntry, undefined)}>Remove SID</button>}
          <button
            ref={menuComposition || onDirectTo && directToPoint || canChooseApproach || canChooseDeparture ? undefined : menuButtonRef}
            type="button"
            className="route-menu-add"
            role="menuitem"
            onClick={() => editInline(menu.entryId, 'insert')}
          >
            Add waypoint before
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => editInline(menu.entryId, 'replace')}
          >
            Replace route item
          </button>
          {onIdentify && identificationPoint && <button type="button" role="menuitem" onClick={() => {
            setMenu(undefined); setCompositionEntry(undefined);
            onIdentify(identificationPoint.feature, routePointKeys(plan).get(identificationPoint));
          }}>Identify point…</button>}
          {menuEntry && !identificationPoint && parseRadialDefinition(menuEntry.text) &&
            <button type="button" role="menuitem" onClick={() => { setMenu(undefined); setIdentificationEntry(menuEntry); }}>Choose reference point…</button>}
          <button
            type="button"
            className="route-menu-remove"
            role="menuitem"
            onClick={() => removeToken(menu.entryId)}
          >
            Remove route item
          </button>
        </div>
      )}
      {compositionEntry && activeComposition && <RouteCompositionPanel ident={compositionEntry.text} composition={activeComposition}
        expansionProblem={expansionProblem}
        onExpand={compositionExpansion ? () => {
          const id = compositionEntry.id;
          const previous = plan.entries[plan.entries.indexOf(compositionEntry) - 1];
          scrollTargetRef.current = id;
          onEditDraft(current => expandRouteEntry(current, plan, id));
          setCompositionEntry(undefined);
          requestAnimationFrame(() => {
            if (!focusToken(id) && !(previous && focusToken(previous.id))) inputRef.current?.focus();
          });
        } : undefined}
        onClose={(restoreFocus = true) => {
          setCompositionEntry(undefined);
          if (restoreFocus) requestAnimationFrame(() => focusToken(compositionEntry.id));
        }} />}
      {activeIdentification && <RadialStationPicker plan={plan} entry={activeIdentification} data={navigationData}
        catalog={catalog} update={onEditDraft} onPreviewChange={onApproachPreview}
        onClose={(restoreFocus = true) => { setIdentificationEntry(undefined);
          if (restoreFocus) requestAnimationFrame(() => focusToken(activeIdentification.id)); }} />}
      {activePicker?.kind === 'approach' && <RouteApproachPicker ident={activePicker.point.ident} feature={activePicker.point.feature}
        navigationData={navigationData}
        resource={approachResource} selected={activePicker.entry.approach}
        routeResource={approachRouteResource} revision={dataRevision}
        arrival={plan.waypoints.find(point => point.edit?.entryId === activePicker.entry.id)?.approachArrival}
        onClose={(restoreFocus = true) => {
          setApproachPicker(undefined);
          if (restoreFocus) requestAnimationFrame(() => focusToken(activePicker.entry.id));
        }} onOpenPlate={onOpenPlate} onPreviewChange={onApproachPreview}
        onSelect={approach => changeApproach(activePicker.entry, approach)} />}
      {activePicker && activePicker.kind !== 'approach' && <RouteTerminalPicker kind={activePicker.kind} ident={activePicker.point.ident} feature={activePicker.point.feature}
        navigationData={navigationData} resource={approachResource} selected={activePicker.entry[activePicker.kind]}
        routeResource={approachRouteResource} revision={dataRevision} onOpenPlate={onOpenPlate} onPreviewChange={onApproachPreview}
        onClose={(restoreFocus = true) => {
          setApproachPicker(undefined);
          if (restoreFocus) requestAnimationFrame(() => focusToken(activePicker.entry.id));
        }} onSelect={selection => activePicker.kind === 'arrival' ? changeArrival(activePicker.entry, selection) : changeDeparture(activePicker.entry, selection)} />}
    </form>
  );
}
