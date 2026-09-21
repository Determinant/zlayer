import { useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { useStoredState } from '../../core/ui/use-persistent-state';
import { isRecord } from '@zlayer/contracts';
import { routeDraftFromText, routeTokensFromText, type RouteEntry } from '@zlayer/domain';
import { EMPTY_ROUTE_DRAFT, type RouteDraft } from './draft';

export type RouteUndo = { canUndo: boolean; canRedo: boolean; undo(): void; redo(): void };

// Keep the storage slot so existing installations migrate once, in place.
const key = 'zlayer-route-draft-v1';
export function useRouteDraft() {
  const [draft, store] = useStoredState(key, readDraft, saveDraft);
  const history = useRef({ past: [] as RouteDraft[], future: [] as RouteDraft[] });
  const actions = useMemo(() => {
    const update: Dispatch<SetStateAction<RouteDraft>> = next => store(current => {
      const value = typeof next === 'function' ? next(current) : next;
      if (value !== current) {
        history.current.past.push(current);
        if (history.current.past.length > 50) history.current.past.shift();
        history.current.future = [];
      }
      return value;
    });
    const travel = (back: boolean) => store(current => {
      const from = back ? history.current.past : history.current.future;
      const to = back ? history.current.future : history.current.past;
      const next = from.pop();
      if (!next) return current;
      to.push(current);
      return next;
    });
    return { update, undo: () => travel(true), redo: () => travel(false) };
  }, [store]);
  return [draft, actions.update, { canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0, undo: actions.undo, redo: actions.redo } satisfies RouteUndo] as const;
}
function saveDraft(draft: RouteDraft): void {
  try { localStorage.setItem(key, JSON.stringify({ version: 2, entries: draft.entries })); }
  catch { /* Full or denied storage must not disable route editing. */ }
}
function readDraft(): RouteDraft {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!isRecord(value)) return EMPTY_ROUTE_DRAFT;
    if (value.version === 1 && typeof value.input === 'string') {
      const count = routeTokensFromText(value.input).length;
      const pins = isRecord(value.pinnedFeatureIds) ? value.pinnedFeatureIds : {};
      const migrated = routeDraftFromText(value.input, Object.fromEntries(Object.entries(pins).flatMap(([index, id]) =>
        /^(0|[1-9]\d*)$/.test(index) && Number(index) < count && typeof id === 'string' && id.length > 0 ? [[index, id]] : [])));
      // Commit this known migration once so generated entry IDs survive reload.
      saveDraft(migrated);
      return migrated;
    }
    if (value.version !== 2 || !Array.isArray(value.entries)) return EMPTY_ROUTE_DRAFT;
    const ids = new Set<string>();
    const entries: RouteEntry[] = [];
    for (const entry of value.entries) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) ||
        typeof entry.text !== 'string' || routeTokensFromText(entry.text).length !== 1 ||
        routeTokensFromText(entry.text)[0] !== entry.text) return EMPTY_ROUTE_DRAFT;
      ids.add(entry.id);
      const approach = entry.approach;
      const approachEntry = isRecord(approach) && isRecord(approach.entry) ? approach.entry : undefined;
      entries.push({ id: entry.id, text: entry.text,
        ...(typeof entry.pinnedFeatureId === 'string' && entry.pinnedFeatureId ? { pinnedFeatureId: entry.pinnedFeatureId } : {}),
        // Discard a malformed attachment without discarding the airport or route.
        ...(isRecord(approach) && ['airportId', 'procedureId', 'name', 'cycle'].every(field =>
          typeof approach[field] === 'string' && approach[field].trim().length > 0)
          ? { approach: { airportId: approach.airportId as string, procedureId: approach.procedureId as string,
            name: approach.name as string, cycle: approach.cycle as string,
            ...(approachEntry && ['routeId', 'transitionId', 'name', 'effectiveDate'].every(field =>
              typeof approachEntry[field] === 'string' && (approachEntry[field] as string).trim().length > 0)
              ? { entry: { routeId: approachEntry.routeId as string, transitionId: approachEntry.transitionId as string,
                name: approachEntry.name as string, effectiveDate: approachEntry.effectiveDate as string } } : {}) } } : {}) });
    }
    return { entries };
  } catch { return EMPTY_ROUTE_DRAFT; }
}
