import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ProcedureDocument } from './data';

export async function procedurePageIndex(
  document: Pick<PDFDocumentProxy, 'getDestination' | 'getPageIndex' | 'numPages'>,
  source: Pick<ProcedureDocument, 'pageIndex' | 'namedDestination'>,
): Promise<number> {
  let index = source.pageIndex;
  if (source.namedDestination) {
    const destination = await document.getDestination(source.namedDestination);
    if (!destination?.[0] && destination?.[0] !== 0) throw new Error('Procedure destination is missing from the PDF');
    index = typeof destination[0] === 'number' ? destination[0] : await document.getPageIndex(destination[0]);
  }
  if (!Number.isInteger(index) || index < 0 || index >= document.numPages) {
    throw new Error('Procedure page is outside the PDF');
  }
  return index;
}
