import type { NotamAirportSnapshot, NotamNavaidSnapshot, NotamRecord, ProcedureAirport, ProcedureCatalog, ProcedureRecord, ProcedureResourceRecord } from '@zlayer/contracts';

/** Invented source examples; no onboarding credentials or live operational advice. */
export const NOTAM_NOW = Date.parse('2026-10-04T12:00:00Z');
export function notice(overrides: Partial<NotamRecord> = {}): NotamRecord {
  return { id: '1757600000000001', sourceId: 'NMS_ID_1757600000000001', revision: 'a'.repeat(64), classification: 'DOMESTIC',
    number: '1001', year: '2026', series: '', locations: ['TST'], icaoLocations: ['KTST'], accountability: 'ZZZ',
    issuedAt: NOTAM_NOW - 60_000, updatedAt: NOTAM_NOW - 60_000, startsAt: NOTAM_NOW - 60_000, endsAt: NOTAM_NOW + 86_400_000,
    sourceUpdatedAt: '2026-10-04T11:59:00.000Z', canceledAt: '', referred: null,
    endKind: 'fixed', effectiveStart: '202610041159', effectiveEnd: '202610051200', schedule: '', changeType: 'N', lifecycle: 'active',
    text: 'RWY 09L RWY END ID LGT U/S', translations: [{ type: 'LOCAL_FORMAT', text: '!TST 10/001 TST RWY 09L RWY END ID LGT U/S 2610041159-2610051200' }],
    sequence: 1, correction: 0, ...overrides };
}
/** Invented departure notice with separate runway minima and conditional alternatives. */
export function departureNotice(): NotamRecord {
  const text = 'ODP TEST MUNICIPAL, TEST CITY, CA.\n' +
    'TAKEOFF MINIMUMS AND (OBSTACLE) DEPARTURE PROCEDURES AMDT 1...\n' +
    'TAKE-OFF MINIMUMS RWY 13, STANDARD WITH MINIMUM CLIMB OF 412 FT/NM TO 3500, OR 3100-3 FOR CLIMB IN VISUAL CONDITIONS.\n' +
    'TAKE-OFF MINIMUMS RWY 31, STANDARD WITH MINIMUM CLIMB OF 210 FT/NM TO 2300, OR 3100-3 FOR CLIMB IN VISUAL CONDITIONS.\n' +
    'ALL OTHER DATA REMAINS AS PUBLISHED. 2610041159-2710042359EST';
  return notice({ classification: 'FDC', text, endKind: 'estimated', effectiveEnd: '202710042359',
    endsAt: Date.parse('2027-10-04T23:59:00Z'),
    translations: [{ type: 'LOCAL_FORMAT', text: `!FDC 6/1001 TST ${text}` }] });
}
/** Invented approach amendment spanning distinct minima categories and note actions. */
export function approachAmendmentNotice(): NotamRecord {
  const text = 'IAP TEST AIRPORT, TEST CITY, CA.\nRNAV (GPS) Y RWY 09L, AMDT 2...\n' +
    'LNAV/VNAV DA 780/HAT 360 ALL CATS, VIS ALL CATS RVR 4000.\n' +
    'LNAV MDA 880/HAT 460 ALL CATS, VIS CATS C/D 1 1/4.\n' +
    'CIRCLING CAT A/B MDA 960/HAA 548, CAT C MDA 1060/HAA 648, VIS CAT C 1 3/4.\n' +
    'CHANGE NOTE TO READ: FOR INOP MALSR, INCREASE LNAV/VNAV ALL CATS VISIBILITY TO 1 1/2 SM AND LNAV CATS C/D VISIBILITY TO 2 SM.\n' +
    'DISREGARD NOTE: RVR 1800 AUTHORIZED WITH USE OF FD OR AP OR HUD TO DA.\n' +
    'MISSED APPROACH: CLIMB TO 520, THEN CLIMBING RIGHT TURN TO 2000 DIRECT WHITE AND ON TRACK 015 TO CROSS AND HOLD.\n' +
    'TEMPORARY CRANE 640 MSL 4200FT EAST OF RWY 09L.';
  return notice({ classification: 'FDC', text, effectiveEnd: '202710042359', endsAt: Date.parse('2027-10-04T23:59:00Z'),
    translations: [{ type: 'LOCAL_FORMAT', text: `!FDC 6/1001 TST ${text} 2610041159-2710042359` }] });
}
/** Invented notices using clause forms observed in the KSJC staging snapshot. */
export function detailedNotices(): NotamRecord[] {
  return [
    { classification: 'FDC', text: 'IAP TEST AIRPORT, CA.\nRNAV (RNP) Z RWY 30L, AMDT 4...\nRNP 0.10 DA 480/HAT 420 ALL CATS, VIS ALL CATS RVR 4000. RNP 0.20 DA 540/HAT 480 ALL CATS, VIS ALL CATS RVR 5000. CHANGE NOTE TO READ: FOR INOP ALS, INCREASE RNP 0.10 ALL CATS VISIBILITY TO RVR 6000. TEMPORARY CRANES UP TO 320 MSL.' },
    { classification: 'DOMESTIC', text: 'RWY 12R/30L CLSD EXC EMERG ACFT' },
    { classification: 'DOMESTIC', text: 'NAV ILS RWY 30L U/S' },
    { classification: 'DOMESTIC', text: 'OBST TOWER LGT (ASR 1234567) 370000.00N1210000.00W (2NM NE TST) 190FT (120FT AGL) U/S' },
    { classification: 'DOMESTIC', text: 'AIRSPACE UAS WI AN AREA DEFINED AS 1NM RADIUS OF 370000N1210000W (2NM NE TST) SFC-300FT AGL DLY 1500-0500' },
  ].map((value, i) => notice({ ...value, id: `175760000000001${i}`, sourceId: `NMS_ID_175760000000001${i}`,
    number: `101${i}`, issuedAt: NOTAM_NOW - i * 1000,
    translations: [{ type: 'LOCAL_FORMAT', text: `!${value.classification === 'FDC' ? 'FDC' : 'TST'} 6/101${i} TST ${value.text} 2610041159-2610051200` }] }));
}
export function notamSnapshot(records: NotamRecord[] = [notice()], overrides: Partial<NotamAirportSnapshot> = {}): NotamAirportSnapshot {
  return { schemaVersion: 1, query: { faaId: 'TST', icaoId: 'KTST' }, scope: 'airport-location', associationCoverage: 'complete', records,
    feed: { enabled: true, environment: 'staging', state: 'ready', generation: 'b'.repeat(64), checkedAt: NOTAM_NOW, watermark: NOTAM_NOW,
      fullSyncAt: NOTAM_NOW, recordCount: records.length, continuity: 'complete', error: null, nextAttemptAt: NOTAM_NOW + 180_000 }, ...overrides };
}
export function navaidSnapshot(records: NotamRecord[] = [], overrides: Partial<NotamNavaidSnapshot> = {}): NotamNavaidSnapshot {
  return { ...notamSnapshot(records), query: { navaidId: 'TST' }, scope: 'navaid-location', associationCoverage: 'complete', ...overrides };
}
export const testProcedure: ProcedureRecord = { id: 'iap-test', kind: 'approach', name: 'RNAV (GPS) Y RWY 09L', sortOrder: 1,
  pdfName: 'test.pdf', pdfUrl: 'test.pdf', namedDestination: null,
  volumeTarget: { volumeId: 'TEST', section: null, printedPage: '1', pageIndex: 0 },
  source: { chartSequence: '1', chartCode: 'IAP', userAction: null, changeNoticeFlag: null, changeNoticeSection: null,
    changeNoticePage: null, procedureId: 'publisher-procedure', twoColored: null, civil: null, faaComputerCode: null,
    copter: null, amendmentNumber: '2', amendmentDate: '2026-09-03', extraFields: {} } };
export const testAirport: ProcedureAirport = { id: 'KTST', faaId: 'TST', icaoId: 'KTST', name: 'Test airport', city: 'Test', state: 'CA',
  volumeId: 'TEST', military: false, sortCode: '', procedures: [testProcedure] };
export const testCatalog: ProcedureCatalog = { schemaVersion: 1, builderVersion: 1, cycle: '2610', effectiveDate: '2026-10-01', expirationDate: '2026-10-29',
  generatedAt: '2026-09-30T00:00:00Z', faaPdfBaseUrl: 'https://example.test/faa/', sourceXml: { url: 'https://example.test/source', sha256: 'a'.repeat(64) },
  volumes: [{ id: 'TEST', url: './test.pdf', byteLength: 1000, sha256: 'c'.repeat(64), pageCount: 3, resolvedTargetCount: 1, unresolvedTargetCount: 0 }], airports: [testAirport] };
export const testResource: ProcedureResourceRecord = { id: 'procedures', title: 'Test', cycle: testCatalog.cycle, effectiveDate: testCatalog.effectiveDate,
  expirationDate: testCatalog.expirationDate, airportCount: 1, sourceAirportCount: 1, procedureCount: 1, sourceProcedureCount: 1,
  url: 'https://example.test/tpp/catalog.json?v=2026-09-30T00%3A00%3A00Z' };
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function aixm(record: NotamRecord = notice()): string {
  return `<m:AIXMBasicMessage xmlns:m="http://www.aixm.aero/schema/5.1/message" xmlns:g="http://www.opengis.net/gml/3.2"
    xmlns:a="http://www.aixm.aero/schema/5.1" xmlns:e="http://www.aixm.aero/schema/5.1/event" xmlns:f="http://www.aixm.aero/schema/5.1/extensions/FAA/FNSE" g:id="${record.sourceId}">
    <e:Event><e:timeSlice><e:EventTimeSlice><a:sequenceNumber>${record.sequence}</a:sequenceNumber><a:correctionNumber>${record.correction}</a:correctionNumber>
    <e:textNOTAM><e:NOTAM><e:number>${record.number}</e:number><e:series>${record.series}</e:series><e:year>${record.year}</e:year><e:type>${record.changeType}</e:type>
    ${record.referred ? `<e:referredSeries>${record.referred.series}</e:referredSeries><e:referredNumber>${record.referred.number}</e:referredNumber><e:referredYear>${record.referred.year}</e:referredYear>` : ''}
    <e:issued>${new Date(record.issuedAt ?? record.updatedAt).toISOString()}</e:issued><e:location>${record.locations.join(' ')}</e:location>
    <e:effectiveStart>${record.effectiveStart}</e:effectiveStart><e:effectiveEnd>${record.effectiveEnd}</e:effectiveEnd><e:schedule>${escape(record.schedule)}</e:schedule><e:text>${escape(record.text)}</e:text>
    ${record.translations.map(t => `<e:translation><e:NOTAMTranslation><e:type>${t.type}</e:type><e:simpleText>${escape(t.text)}</e:simpleText></e:NOTAMTranslation></e:translation>`).join('')}
    </e:NOTAM></e:textNOTAM><e:extension><f:EventExtension><f:classification>${record.classification}</f:classification><f:accountId>${record.accountability}</f:accountId>
    <f:icaoLocation>${record.icaoLocations.join(' ')}</f:icaoLocation><f:lastUpdated>${new Date(record.updatedAt).toISOString()}</f:lastUpdated>
    ${record.lifecycle === 'cancelled' ? `<f:canceled>${new Date(record.updatedAt).toISOString()}</f:canceled>` : ''}
    </f:EventExtension></e:extension></e:EventTimeSlice></e:timeSlice></e:Event></m:AIXMBasicMessage>`;
}
export function bulkXml(records: NotamRecord[], time = NOTAM_NOW, count = records.length) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
    <w:FeatureCollection xmlns:w="http://www.opengis.net/wfs/2.0" numberReturned="${count}" timeStamp="${new Date(time).toISOString()}">
    ${records.map(r => `<w:member>${aixm(r)}</w:member>`).join('')}</w:FeatureCollection></s:Body></s:Envelope>`;
}
