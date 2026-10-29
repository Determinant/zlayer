/** FAA JO 7930.2U §1-2-1 keyword vocabulary. Classification, envelope
 * recognition and operational interpretation remain separate decisions. */
export const subjects: Readonly<Record<string, string>> = { RWY: 'Runway', TWY: 'Taxiway', APRON: 'Apron', AD: 'Aerodrome',
  OBST: 'Obstruction', NAV: 'Navigation', COM: 'Communications', SVC: 'Services', AIRSPACE: 'Airspace',
  ODP: 'Departure', SID: 'Departure', STAR: 'Arrival', CHART: 'Chart', DATA: 'Data', DVA: 'Vector Area',
  IAP: 'Approach', VFP: 'Visual Procedure', ROUTE: 'Route', SPECIAL: 'Special', SECURITY: 'Security' };
export const isNotamSubject = (value: string): boolean => Object.hasOwn(subjects, value);
