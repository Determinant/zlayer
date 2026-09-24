import { readFileSync } from 'node:fs';

// Spatially constant GRIB2 fields, with distinct forecast hours and independently
// captured HRRR geometry. Every adjacent forecast crosses palette bins, including
// clear forecasts, so full-horizon UI tests detect accidentally repeated frames.
const source = readFileSync(new URL('./awc-grib/hrrr-116.grib2', import.meta.url));
let geometry;
for (let i = 16; i < source.length - 4; i += source.readUInt32BE(i)) if (source[i + 4] === 3) geometry = source.subarray(i, i + source.readUInt32BE(i));
const section = (number, size) => { const b = Buffer.alloc(size); b.writeUInt32BE(size); b[4] = number; return b; };
function field(lead, category, parameter, surface, value, altitude) {
  const ids = section(1, 21); ids.writeUInt16BE(7, 5); ids.writeUInt16BE(category === 19 ? 8 : 0, 7); ids[9] = 2; ids[10] = 1;
  ids.writeUInt16BE(2026, 12); ids[14] = 9; ids[15] = 22; ids[16] = 20;
  const product = section(4, 34); product[9] = category; product[10] = parameter; product[17] = 1; product.writeUInt32BE(lead, 18);
  product[22] = surface; product[28] = 255;
  if (altitude) { product[23] = surface === 100 ? 0 : 1; product.writeUInt32BE(surface === 100 ? altitude * 100 : Math.round(altitude * 3.048), 24); }
  const packing = section(5, 21); packing.writeUInt32BE(1799 * 1059, 5); packing.writeFloatBE(value, 11);
  const bitmap = section(6, 6); bitmap[5] = 255;
  const parts = [ids, geometry, product, packing, bitmap, section(7, 5), Buffer.from('7777')];
  const header = Buffer.alloc(16); header.write('GRIB'); header[7] = 2; header.writeBigUInt64BE(BigInt(16 + parts.reduce((n,b) => n + b.length, 0)), 8);
  return Buffer.concat([header, ...parts]);
}
export function nativeForecastFiles() {
  const files = new Map();
  for (const product of ['clouds', 'icing', 'winds']) for (let lead = product === 'icing' ? 1 : 0; lead <= 18; lead++) {
    const records = [];
    const phase = Math.max(0, lead - 1) % 5;
    if (product === 'clouds') for (const [parameter, surface, type, value] of [
      ['TCDC','entire atmosphere',10,[75,0,25,50,10][phase]], ['HGT','cloud base',2,1000], ['HGT','cloud top',3,6000],
      ['HGT','0C isotherm',4,3000], ['HGT','highest tropospheric freezing level',204,4500], ['HGT','surface',1,1500],
    ]) records.push({ parameter, surface, bytes: field(lead, parameter === 'TCDC' ? 6 : 3, parameter === 'TCDC' ? 1 : 5, type, value) });
    else if (product === 'winds') for (let pressure = 1000; pressure >= 100; pressure -= 25) {
      for (const [parameter, category, number, value] of [['HGT',3,5,10+(1000-pressure)*12], ['UGRD',2,2,[10,20,0,-20,30][phase]], ['VGRD',2,3,[5,0,0,10,-10][phase]], ['TMP',0,0,273.15 + [10,-10,-30,25,0][phase]]])
        records.push({ parameter, surface: `${pressure} mb`, bytes: field(lead, category, number, 100, value, pressure) });
    }
    else for (const [parameter, number, value] of [['ICPRB',233,[0.7,0,1,0.25,0.5][phase]], ['SIPD',217,[0.25,0,0.75,0.5,1][phase]], ['var discipline=0 master_table=2 parmcat=19 parm=37',37,[3,0,4,1,2][phase]]]) {
      for (let altitude = 500; altitude <= 30000; altitude += 500) records.push({ parameter, surface: `${Number((altitude * 0.3048).toFixed(1))} m above mean sea level`, bytes: field(lead, 19, number, 102, value, altitude) });
    }
    let offset = 0;
    const index = records.map((r,i) => { const row = `${i+1}:${offset}:d=2026092220:${r.parameter}:${r.surface}:${lead ? `${lead} hour fcst` : 'anl'}:\n`; offset += r.bytes.length; return row; }).join('');
    const path = '/weather/noaa/' + (product !== 'icing'
      ? `hrrr/prod/hrrr.20260922/conus/hrrr.t20z.wrf${product === 'winds' ? 'prs' : 'sfc'}f${String(lead).padStart(2,'0')}.grib2`
      : `dafs/prod/dafs.20260922/dafs.t20z.ifi.3km.conus.f${String(lead).padStart(3,'0')}.grib2`);
    files.set(path, Buffer.concat(records.map(r=>r.bytes))); files.set(path + '.idx', Buffer.from(index));
  }
  return files;
}
