import { expose, transfer } from 'comlink';
import initSqlJs from 'sql.js';
import sqliteWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

import { extractPackageTiles, MAX_FAST_PACKAGE_BYTES } from './package-reader';

// One SQLite/WASM heap for all packages; no worker or database per cached file.
let sqlite: ReturnType<typeof initSqlJs> | undefined;
const decoder = {
  async decode(bytes: ArrayBuffer) {
    if (bytes.byteLength > MAX_FAST_PACKAGE_BYTES) throw new Error('Chart package exceeds fast-reader limit');
    const SQL = await (sqlite ??= initSqlJs({ locateFile: () => sqliteWasmUrl }))
      .catch(error => { sqlite = undefined; throw error; });
    const db = new SQL.Database(new Uint8Array(bytes));
    try {
      const tiles = extractPackageTiles(db);
      return transfer(tiles, tiles.map(tile => tile.data));
    } finally { db.close(); }
  },
};
export type PackageDecoder = typeof decoder;
expose(decoder);
