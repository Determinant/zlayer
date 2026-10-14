import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Pinned FAA source/layout; review the source and this extractor when updating.
// Usage and provenance: src/layers/weather-awc/pireps/aircraft-types.md
const hashes = ['64a709bf8863e177c3daffade253aa6362519186ba807943165f68490ee0c8fe',
  'bc659054b08e5b1d9fa63d8e4e78d925fdff1b380ef613ecbe6c0777429746e3'];
const inputs = process.argv.slice(2);
assert.equal(inputs.length, 2, 'Pass the JO 7360.1K and JO 7360.7 PDFs');
const sources = await Promise.all(inputs.map(async (path, i) => {
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[i], 'Unexpected FAA source revision');
  return bytes;
}));
const task = getDocument({ data: new Uint8Array(sources[0]), useSystemFonts: true });
const rows = new Map();
try {
  const pdf = await task.promise;
  let current, lastY;
  for (let pageNumber = 10; pageNumber <= 121; pageNumber++) {
    const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
    assert.ok(content.items.some(item => item.str === 'Appendix A'));
    // PDF reading order preserves table cells even where designators are vertically centered.
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const [x, y] = item.transform.slice(4), text = item.str.trim();
      if (y < 65 || y > 720) continue;
      if (x >= 72 && x < 110 && /^[A-Z0-9]{2,4}$/.test(text)) {
        assert.ok(!rows.has(text), `Duplicate designator ${text}`);
        current = []; rows.set(text, current); lastY = undefined;
      } else if (x >= 323 && text !== 'MANUFACTURER, Model') {
        assert.ok(current, 'Model without a designator');
        if (y === lastY) current[current.length - 1] += ' ' + text;
        else current.push(text);
        lastY = y;
      }
    }
  }
} finally { await task.destroy(); }
assert.equal(rows.size, 2704, 'Incomplete designator table');

// Prefer familiar, source-listed names over alphabetically earlier licensees.
const preferred = {
  C150: 'CESSNA, 150', C152: 'CESSNA, 152', C172: 'CESSNA, 172 Skyhawk', C177: 'CESSNA, 177 Cardinal',
  C182: 'CESSNA, 182 Skylane', C206: 'CESSNA, 206 Stationair', C210: 'CESSNA, 210 Centurion',
  DA40: 'DIAMOND, DA-40 Diamond Star', DHC6: 'DE HAVILLAND CANADA, DHC-6 Twin Otter', R22: 'ROBINSON, R-22',
};
function readable(source) {
  if (source.startsWith('(any manufacturer)')) return source.replace(/^\(any manufacturer\)[, ]+/, '');
  // Three punctuation defects in the published first model lines; words stay unchanged.
  source = source.replace(/^AIRBUS\. /, 'AIRBUS, ').replace(/^BEECH\. /, 'BEECH, ').replace(/^GM&T Pretty/, 'GM&T, Pretty');
  const comma = source.indexOf(',');
  assert.ok(comma > 0, `Missing manufacturer/model separator: ${source}`);
  assert.ok(source.slice(comma + 1).trim(), `Missing model: ${source}`);
  const make = source.slice(0, comma).replace(/ \(\d+\)/g, '').replace(/[A-Z]{4,}/g, word => word[0] + word.slice(1).toLowerCase());
  return `${make} ${source.slice(comma + 1).trim()}`;
}
const names = {};
for (const [code, models] of rows) {
  assert.ok(models.length, `Missing model for ${code}`);
  if (preferred[code]) assert.ok(models.includes(preferred[code]), `Preferred name absent for ${code}`);
  names[code] = readable(preferred[code] ?? models[0]);
}
// Broad families must not imply a particular engine, submodel or licensed manufacturer.
for (const [code, witness, label] of [
  ['B06', 'BELL, 206A JetRanger', 'Bell 206 JetRanger / LongRanger'],
  ['C208', 'CESSNA, 208 Caravan 1', 'Cessna 208 Caravan'],
  ['P28A', 'PIPER, PA-28-140 Cherokee', 'Piper PA-28 Cherokee / Warrior / Archer'],
  ['P28B', 'PIPER, PA-28-235 Cherokee', 'Piper PA-28 Cherokee / Dakota'],
  ['P28R', 'PIPER, PA-28R-180 Cherokee Arrow', 'Piper PA-28R Arrow'],
  ['P28S', 'PIPER, PA-28R-201T Turbo Arrow', 'Piper PA-28R Turbo Arrow'],
  ['P28T', 'PIPER, PA-28RT-201 Arrow 4', 'Piper PA-28RT Arrow'],
  ['P32R', 'PIPER, PA-32R-300 Lance', 'Piper PA-32R Lance / Saratoga'],
  ['P32T', 'PIPER, PA-32RT-300 Lance 2', 'Piper PA-32RT Lance'],
  ['R44', 'ROBINSON, R-44 Raven', 'Robinson R-44'],
]) {
  assert.ok(rows.get(code).includes(witness), `Family name absent for ${code}`);
  names[code] = label;
}
delete names.ZZZZ; // Explicit unknown type, not a model name.
names.EL2 = 'Electra EL-2'; // Active JO 7360.7 amendment; temporary FAA designator.
await writeFile(new URL('../src/layers/weather-awc/pireps/aircraft-types.json', import.meta.url),
  JSON.stringify(Object.fromEntries(Object.entries(names).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
console.log(`Wrote ${Object.keys(names).length} aircraft type names.`);
