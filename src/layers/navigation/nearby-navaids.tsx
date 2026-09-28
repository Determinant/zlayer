import { radialReference, type RadialReference, featureKey, MON_VOR_REFERENCE_DATE, NEARBY_VOR_MAP_LIMIT, NEARBY_VOR_RADIUS_NM, type NearbyVor } from '@zlayer/domain';
import { formatNavaidRadial, formatNavaidTrueBearing } from './nearby-navaids-format';

export function NearbyNavaids({ stations, loading = false, selection }: {
  stations: readonly NearbyVor[] | undefined; loading?: boolean;
  selection?: { reference: RadialReference | undefined; onSelect: (station: NearbyVor) => void } | undefined;
}) {
  const hasMissingRadials = stations?.some(station => station.radial === null);
  return <section className="nearby-navaids" aria-label="Nearby VOR/DME">
    <h3>Nearby VOR/DME</h3>
    {selection && <p className="navaid-select-hint">Select a station to use its radial and distance.</p>}
    {stations?.length ? <>
      <table>
        <thead><tr><th scope="col">Station</th><th scope="col">Bearing</th><th scope="col">NM</th></tr></thead>
        <tbody>{stations.map((station, index) => {
          const { feature, distanceNm, radial, trueBearing, mon } = station;
          const reference = radialReference(feature);
          const selected = !!selection?.reference && JSON.stringify(selection.reference) === JSON.stringify(reference);
          const label = <><span className="navaid-station-title"><strong>{feature.properties.ident}</strong>
            {selected && <svg className="navaid-selected" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}
            {mon && <span className="navaid-mon" title={`FAA MON candidate retention list · ${MON_VOR_REFERENCE_DATE}`}>MON</span>}</span>
            <small className="navaid-station-detail">{[feature.properties.frequency, feature.properties.type].filter(Boolean).join(' ')}</small></>;
          return <tr key={featureKey(feature)}
            className={[index < NEARBY_VOR_MAP_LIMIT || selected ? 'is-mapped' : '', selected ? 'is-selected' : ''].filter(Boolean).join(' ')}>
          <th scope="row">{selection ? <button type="button" className="ui-button navaid-select"
            aria-label={`Use ${feature.properties.ident} radial and distance`} aria-pressed={selected}
            disabled={!reference || radial === null || distanceNm <= 0} onClick={() => selection.onSelect(station)}>
            {label}</button> : label}</th>
          <td className="navaid-bearings">
            <strong className="navaid-magnetic" title={radial === null ? 'Magnetic bearing unavailable' : 'Magnetic bearing (VOR radial)'}>
              {formatNavaidRadial({ radial })}</strong>
            <small className="navaid-true" title="True bearing">{formatNavaidTrueBearing({ trueBearing })}</small>
          </td>
          <td>{distanceNm.toFixed(1)}</td>
        </tr>; })}</tbody>
      </table>
      <p>Bearings from station · Ground distance</p>
      <p>MB = magnetic · TB = true</p>
      <p className="navaid-map-key"><span aria-hidden="true" />Top {Math.min(stations.length, NEARBY_VOR_MAP_LIMIT)} shown on map</p>
      <p>5–60 NM preferred · MON stations first</p>
      {hasMissingRadials && <p>MB — = magnetic bearing unavailable; station alignment is missing from this navigation data.</p>}
    </> : <p role="status">{loading ? 'Loading nearby stations…' : !stations ? 'Navaid data unavailable.'
      : `No VOR stations within ${NEARBY_VOR_RADIUS_NM} NM.`}</p>}
    {selection?.reference && <p className="navaid-map-key is-selected"><span aria-hidden="true" />Selected reference · Yellow trim</p>}
  </section>;
}
