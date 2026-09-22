import { openProcedurePdf } from './pdf-document';
import { withAbort } from '../../core/data/abort';
import { procedurePageIndex } from './page-target';
import { preparePlateMapImage } from './prepare-map-image';
import type { ProcedureSelection } from './data';
import type { PlateMapImage } from './map-image';

/** Rebuild only the selected approach, never the reader's last browsed page. */
export async function restorePlateMapImage(selection: ProcedureSelection, signal: AbortSignal): Promise<PlateMapImage> {
  const { document: pdf, release, signal: readSignal } = await openProcedurePdf(selection.document, signal);
  try {
    const pageIndex = await withAbort(procedurePageIndex(pdf, selection.document), readSignal);
    return await preparePlateMapImage(pdf, pageIndex, selection, readSignal);
  } catch (error) {
    // Worker teardown can cancel a render before its failure signal is observed.
    readSignal.throwIfAborted();
    throw error;
  } finally {
    release();
  }
}
