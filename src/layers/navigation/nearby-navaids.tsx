import { featureKey, MON_VOR_REFERENCE_DATE, NEARBY_VOR_MAP_LIMIT, NEARBY_VOR_RADIUS_NM, type NearbyVor } from '@zlayer/domain';
import { formatNavaidRadial, formatNavaidTrueBearing } from './nearby-navaids-format';

export function NearbyNavaids({ stations, loading = false }: {
  stations: readonly NearbyVor[] | undefined; loading?: boolean;
}) {
  const hasMissingRadials = stations?.some(station => station.radial === null);
  return <section className="nearby-navaids" aria-label="Nearby VOR/DME">
    <h3>Nearby VOR/DME</h3>
    {stations?.length ? <>
      <table>
        <thead><tr><th scope="col">Station</th><th scope="col">Bearing</th><th scope="col">NM</th></tr></thead>
        <tbody>{stations.map(({ feature, distanceNm, radial, trueBearing, mon }, index) => <tr key={featureKey(feature)}
          className={index < NEARBY_VOR_MAP_LIMIT ? 'is-mapped' : undefined}>
          <th scope="row"><strong>{feature.properties.ident}</strong>
            {mon && <span className="navaid-mon" title={`FAA MON candidate retention list · ${MON_VOR_REFERENCE_DATE}`}>MON</span>}
            <small>{[feature.properties.frequency, feature.properties.type].filter(Boolean).join(' · ')}</small></th>
          <td className="navaid-bearings">
            <strong className="navaid-magnetic" title={radial === null ? 'Magnetic bearing unavailable' : 'Magnetic bearing (VOR radial)'}>
              {formatNavaidRadial({ radial })}</strong>
            <small className="navaid-true" title="True bearing">{formatNavaidTrueBearing({ trueBearing })}</small>
          </td>
          <td>{distanceNm.toFixed(1)}</td>
        </tr>)}</tbody>
      </table>
      <p>Bearings from station · Ground distance</p>
      <p>MB = magnetic · TB = true</p>
      <p className="navaid-map-key"><span aria-hidden="true" />Top {Math.min(stations.length, NEARBY_VOR_MAP_LIMIT)} shown on map</p>
      <p>5–60 NM preferred · MON stations first</p>
      {hasMissingRadials && <p>MB — = magnetic bearing unavailable; station alignment is missing from this navigation data.</p>}
    </> : <p role="status">{loading ? 'Loading nearby stations…' : !stations ? 'Navaid data unavailable.'
      : `No VOR stations within ${NEARBY_VOR_RADIUS_NM} NM.`}</p>}
  </section>;
}
