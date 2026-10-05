import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ProcedureCatalog } from '@zlayer/contracts';
import { useOnline } from '../../core/use-online';
import { fetchProcedureCatalog } from './api';
import type { ProcedureSelection } from './data';
import { resolvePlateNoticeContext, type PlateNoticeContext } from './page-context';

export type PlateNoticeProps = { selection: ProcedureSelection; pageIndex: number; active: boolean };
export function PlateNoticeContextLoader({ selection, pageIndex, active, children }: PlateNoticeProps & {
  children(context: PlateNoticeContext, retryCatalog?: () => void): ReactNode;
}) {
  const online = useOnline();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const [saved, setSaved] = useState<{ selection: ProcedureSelection; catalog?: ProcedureCatalog; failed?: boolean }>();
  useEffect(() => {
    if (!active || !selection.catalog || selection.document.source === 'chart-supplement') return;
    let current = true;
    setSaved(previous => previous?.selection === selection && previous.catalog ? previous : { selection });
    void fetchProcedureCatalog(selection.catalog).then(catalog => { if (current) setSaved({ selection, catalog }); },
      () => { if (current) setSaved({ selection, failed: true }); });
    return () => { current = false; };
  }, [selection, active, online, attempt]);
  const result = saved?.selection === selection ? saved : undefined;
  const context = resolvePlateNoticeContext(selection, pageIndex, result?.catalog);
  if (context.status === 'unavailable' && selection.catalog && !result?.catalog && !result?.failed) context.status = 'loading';
  return children(context, result?.failed ? retry : undefined);
}
