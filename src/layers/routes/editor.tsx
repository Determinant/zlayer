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

import type { RoutePlan, RouteWaypoint } from '@zlayer/domain';

import { RouteMenu } from './menu';
import { backspaceRouteTokenIndex, updateRouteEntry } from './entry';
import type { RouteLoadStatus } from './use-plan';
import { useEditorGestures, type DragVisual } from './use-editor-gestures';

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
  tools,
}: RouteEditorProps) {
  const [entry, setEntry] = useState('');
  const revision = plan.revision;
  const { drag, menu, setMenu, formRef, editorRef, inputRef, menuButtonRef, openMenu, beginPointer, movePointer, finishPointer } =
    useEditorGestures(revision, onMoveEntry);
  const [inlineEdit, setInlineEdit] = useState<{ entryId: string; mode: 'insert' | 'replace'; originalText: string }>();
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
    () => new Set(plan.issues.map((issue) => issue.tokenIndex)),
    [plan.issues],
  );
  const canFit = plan.waypoints.length > 0;
  const procedureByToken = useMemo(() => new Map(plan.procedures.map(procedure =>
    [procedure.tokenIndex, procedure])), [plan.procedures]);
  const tecByToken = useMemo(() => new Map(plan.tecRoutes.map(tec => [tec.tokenIndex, tec])), [plan.tecRoutes]);

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
      <RouteMenu plan={plan} onOpen={() => setMenu(undefined)} onClear={() => {
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
        >
          <span>{menu.ident}</span>
          <button
            ref={menuButtonRef}
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
    <li className={dropClass} data-route-entry={entryId}>
      <button
        type="button"
        className={`route-token ${stateClass}${isDragging ? ' is-dragging' : ''}`}
        style={isDragging ? { transform: `translate3d(${drag.offsetX}px, 0, 0)` } : undefined}
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
