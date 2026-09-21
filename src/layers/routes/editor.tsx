import {
  Fragment,
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { RouteApproach, RouteEntry as DraftEntry, RoutePlan, RouteWaypoint } from '@zlayer/domain';
import type { ProcedureResourceRecord } from '@zlayer/contracts';

import { RouteMenu } from './menu';
import { backspaceRouteTokenIndex, updateRouteEntry } from './entry';
import type { RouteLoadStatus } from './use-plan';
import { useEditorGestures, type DragVisual } from './use-editor-gestures';
import type { DirectToAction } from './direct-to';
import { DirectToIcon } from './direct-to-icon';
import { RouteApproachPicker } from './approach-picker';
import type { RouteMapPreview } from './map-preview';
import type { ProcedureSelection } from '../plates/data';
import type { RouteUndo } from './use-draft';

type RouteEditorProps = {
  plan: RoutePlan;
  status: RouteLoadStatus;
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
  onApproachPreview?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  onOpenPlate?: ((selection: ProcedureSelection) => void) | undefined;
  undo?: RouteUndo | undefined;
  tools: ReactNode;
};

export function RouteEditor({
  plan,
  status,
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
  onApproachPreview,
  onOpenPlate,
  undo,
  tools,
}: RouteEditorProps) {
  const [entry, setEntry] = useState('');
  const revision = plan.revision;
  const { drag, menu, setMenu, formRef, editorRef, inputRef, menuButtonRef, openMenu, beginPointer, movePointer, finishPointer } =
    useEditorGestures(revision, onMoveEntry);
  const [inlineEdit, setInlineEdit] = useState<{ entryId: string; mode: 'insert' | 'replace'; originalText: string }>();
  const [approachPicker, setApproachPicker] = useState<{ entry: DraftEntry; point: RouteWaypoint }>();
  const scrollTargetRef = useRef<string | undefined>(undefined);
  const previousEntryCountRef = useRef<number | undefined>(undefined);
  const waypointByToken = useMemo(
    () => new Map(plan.waypoints.flatMap((waypoint) =>
      waypoint.tokenIndex === undefined ? [] : [[waypoint.tokenIndex, waypoint] as const]
    )),
    [plan.waypoints],
  );
  const airwayByToken = useMemo(
    () => new Map(plan.airways.map((airway) => [airway.tokenIndex, airway])),
    [plan.airways],
  );
  const issueTokenIndexes = useMemo(
    () => new Set(plan.issues.filter(issue => issue.code !== 'approach-discontinuity').map((issue) => issue.tokenIndex)),
    [plan.issues],
  );
  const canFit = plan.waypoints.length > 0;
  const procedureByToken = useMemo(() => new Map(plan.procedures.map(procedure =>
    [procedure.tokenIndex, procedure])), [plan.procedures]);
  const tecByToken = useMemo(() => new Map(plan.tecRoutes.map(tec => [tec.tokenIndex, tec])), [plan.tecRoutes]);
  const directToPoint = menu && plan.waypoints.find(point => point.edit?.entryId === menu.entryId);
  const menuEntry = menu && plan.entries.find(entry => entry.id === menu.entryId);
  const canChooseApproach = !!onApproachChange && directToPoint?.layer === 'airports';
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
    [...editorRef.current?.querySelectorAll<HTMLElement>('[data-route-entry]') ?? []]
      .find(element => element.dataset.routeEntry === entryId)?.querySelector<HTMLButtonElement>('.route-token')?.focus();
  };
  const chooseApproach = (entry: DraftEntry, point: RouteWaypoint) => {
    setMenu(undefined);
    focusToken(entry.id);
    setApproachPicker({ entry, point });
  };
  const changeApproach = (entry: DraftEntry, approach: RouteApproach | undefined) => {
    onApproachChange?.(entry, approach);
    setMenu(undefined);
    setApproachPicker(undefined);
    requestAnimationFrame(() => focusToken(entry.id));
  };

  return (
    <form
      className="route-input"
      ref={formRef}
      onKeyDown={event => {
        if (!undo || !(event.ctrlKey || event.metaKey) || event.altKey ||
          (event.target as HTMLElement).matches('input, textarea, [contenteditable="true"]')) return;
        const key = event.key.toLowerCase();
        if (key !== 'z' && key !== 'y') return;
        event.preventDefault();
        if (event.shiftKey || key === 'y') undo.redo(); else undo.undo();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (entry) commitEntry();
        else if (inlineEdit) commitEntry();
        else if (canFit) onFit();
      }}
    >
      <RouteMenu plan={plan} undo={undo} onOpen={() => setMenu(undefined)} onClear={() => {
        setEntry('');
        setMenu(undefined);
        setInlineEdit(undefined);
        onClear();
        requestAnimationFrame(() => inputRef.current?.focus());
      }} />
      <div
        className="route-editor"
        ref={editorRef}
        onClick={() => inputRef.current?.focus()}
      >
        <ol className="route-token-list" aria-label="Route entries">
          {plan.entries.map((item, tokenIndex) => {
            const token = item.text;
            const waypoint = waypointByToken.get(tokenIndex);
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
                  onChooseApproach={onApproachChange && waypoint?.layer === 'airports' ? () => chooseApproach(item, waypoint) : undefined}
                  onRemoveApproach={onApproachChange ? () => changeApproach(item, undefined) : undefined}
                  waypoint={waypoint}
                  airway={airwayByToken.get(tokenIndex)}
                  procedure={procedureByToken.get(tokenIndex)}
                  tec={tecByToken.get(tokenIndex)}
                  invalid={issueTokenIndexes.has(tokenIndex)}
                  pending={status === 'loading'}
                  drag={drag}
                  onPointerDown={(event) => beginPointer(event, item.id, ident)}
                  onPointerMove={movePointer}
                  onPointerUp={(event) => finishPointer(event, false)}
                  onPointerCancel={(event) => finishPointer(event, true)}
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
          {onDirectTo && directToPoint && <button ref={menuButtonRef} type="button" className="route-menu-direct-to" role="menuitem"
            onClick={() => {
              onDirectTo(directToPoint.feature, directToPoint);
              setMenu(undefined);
              setEntry('');
              setInlineEdit(undefined);
              inputRef.current?.focus();
            }}><DirectToIcon />Direct to</button>}
          {canChooseApproach && menuEntry && directToPoint && <button type="button" role="menuitem"
            ref={onDirectTo && directToPoint ? undefined : menuButtonRef}
            onClick={() => chooseApproach(menuEntry, directToPoint)}>
            {menuEntry.approach ? 'Change approach…' : 'Choose approach…'}
          </button>}
          {menuEntry?.approach && onApproachChange && <button type="button" role="menuitem" className="route-menu-remove"
            onClick={() => changeApproach(menuEntry, undefined)}>Remove approach</button>}
          <button
            ref={onDirectTo && directToPoint || canChooseApproach ? undefined : menuButtonRef}
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
      {activePicker && <RouteApproachPicker ident={activePicker.point.ident} feature={activePicker.point.feature}
        resource={approachResource} selected={activePicker.entry.approach}
        routeResource={approachRouteResource} revision={dataRevision}
        arrival={plan.waypoints.find(point => point.edit?.entryId === activePicker.entry.id)?.approachArrival}
        onClose={(restoreFocus = true) => {
          setApproachPicker(undefined);
          if (restoreFocus) requestAnimationFrame(() => focusToken(activePicker.entry.id));
        }} onOpenPlate={onOpenPlate} onPreviewChange={onApproachPreview}
        onSelect={approach => changeApproach(activePicker.entry, approach)} />}
    </form>
  );
}

type RouteEntryProps = {
  value: string;
  placeholder: string;
  ariaLabel: string;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
};

const RouteEntry = forwardRef<HTMLInputElement, RouteEntryProps>(function RouteEntry(
  { value, placeholder, ariaLabel, onChange, onKeyDown, onBlur },
  ref,
) {
  return (
    <input
      ref={ref}
      className="route-entry"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      aria-label={ariaLabel}
      aria-describedby="route-summary route-recommend-hint"
      autoCapitalize="characters"
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
    />
  );
});

type RouteTokenProps = {
  entryId: string;
  ident: string;
  approach: RouteApproach | undefined;
  onChooseApproach: (() => void) | undefined;
  onRemoveApproach: (() => void) | undefined;
  waypoint: RouteWaypoint | undefined;
  airway: RoutePlan['airways'][number] | undefined;
  procedure: RoutePlan['procedures'][number] | undefined;
  tec: RoutePlan['tecRoutes'][number] | undefined;
  invalid: boolean;
  pending: boolean;
  drag: DragVisual | undefined;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onOpenMenu: (element: HTMLButtonElement) => void;
};

function RouteToken({
  entryId,
  ident,
  approach,
  onChooseApproach,
  onRemoveApproach,
  waypoint,
  airway,
  procedure,
  tec,
  invalid,
  pending,
  drag,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onOpenMenu,
}: RouteTokenProps) {
  const stateClass = routeTokenStateClass({ waypoint, airway, procedure, tec, invalid, pending });
  const description = tec ? `${ident} · TEC · ${tec.route.originId} → ${tec.route.destinationId}` : procedure
    ? `${ident} · ${procedure.kind === 'departure' ? 'SID' : 'STAR'} · ${procedure.airport} · ${procedure.transition} transition · waypoint preview`
    : airway ? `${ident} · ${airway.entry} → ${airway.exit}` : ident;
  const unresolved = stateClass === 'is-unresolved';
  const statusDescription = unresolved ? ' · Invalid or unknown route entry' : stateClass === 'is-pending' ? ' · Resolving route entry' : '';
  const isDragging = drag?.sourceId === entryId;
  const dropClass = drag && drag.sourceId !== entryId && drag.targetId === entryId
    ? drag.before ? 'is-drop-before' : 'is-drop-after'
    : '';
  return (
    <li className={`${dropClass}${approach ? ' route-approach-bundle' : ''}${isDragging ? ' is-entry-dragging' : ''}`}
      style={isDragging ? { transform: `translate3d(${drag.offsetX}px, 0, 0)` } : undefined}
      data-route-entry={entryId}>
      {approach && <span className="route-approach-outline" aria-hidden="true" />}
      {approach && <>
        <button type="button" className="route-attached-approach" title={`${approach.name}${approach.entry ? ` · ${approach.entry.name}` : ''}`}
          aria-label={`Change approach for ${ident}: ${approach.name}`} disabled={!onChooseApproach}
          aria-description={approach.entry ? `Entry: ${approach.entry.name}` : 'Choose an approach entry'}
          onClick={event => { event.stopPropagation(); onChooseApproach?.(); }}
          onContextMenu={event => { event.preventDefault(); onOpenMenu(event.currentTarget); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h4v5h7M10 5l3 3-3 3" /></svg>
          <span>{approach.name.replace(/\b(?:RWY|RUNWAY)\s+/gi, '')}{approach.entry ? ` · ${approach.entry.name}` : ''}</span>
        </button>
        {onRemoveApproach && <button type="button" className="route-detach-approach"
          aria-label={`Remove ${approach.name} approach from ${ident}`} title="Remove approach"
          onClick={event => { event.stopPropagation(); onRemoveApproach(); }}>×</button>}
      </>}
      <button
        type="button"
        className={`route-token ${stateClass}${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
        onContextMenu={(event) => {
          event.preventDefault();
          onOpenMenu(event.currentTarget);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) onOpenMenu(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            onOpenMenu(event.currentTarget);
          }
        }}
        aria-label={`${description}${statusDescription}. Drag to reorder; open context menu for actions.`}
        aria-invalid={unresolved || undefined}
        aria-haspopup="menu"
        title={`${description}${statusDescription} · drag to reorder`}
      >
        <strong>{ident}</strong>
      </button>
    </li>
  );
}

function routeTokenStateClass(
  token: Pick<RouteTokenProps, 'waypoint' | 'airway' | 'procedure' | 'tec' | 'invalid' | 'pending'>,
): string {
  if (token.invalid) return token.pending ? 'is-pending' : 'is-unresolved';
  if (token.procedure) return 'is-procedure';
  if (token.tec) return 'is-tec';
  if (token.waypoint?.layer === 'navaids' && /\bNDB\b/i.test(token.waypoint.feature.properties.type ?? '')) return 'is-ndb';
  if (token.waypoint) return `is-${token.waypoint.layer}`;
  if (token.airway) return 'is-airway';
  return token.pending ? 'is-pending' : 'is-unresolved';
}
