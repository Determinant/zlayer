import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Read ranges locally from one verified whole book; never fetch individual ranges. */
export class BlobRangeTransport extends PDFDataRangeTransport {
  #aborted = false;
  constructor(readonly blob: Blob, readonly onError: (error: unknown) => void) {
    super(blob.size, new Uint8Array(), true);
  }

  override requestDataRange(begin: number, end: number): void {
    void this.blob.slice(begin, end).arrayBuffer().then(buffer => {
      if (!this.#aborted) this.onDataRange(begin, new Uint8Array(buffer));
    }).catch(error => { if (!this.#aborted) this.onError(error); });
  }

  override abort(): void { this.#aborted = true; }
}
