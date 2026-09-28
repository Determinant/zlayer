import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CatalogResponse, GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { distanceNm, emptyRoutePlan, geographicMidpoint, featureIdent, featureKey, nearbyNamedRoutePoints, parseRadialDefinition, positionOnRadial,
  isVorReference, radialReferenceCandidates, referenceForDefinition, routeIdentificationKey, routePointLabel, type RouteDraft, type RouteEntry, type RoutePlan,
  type RoutePointForm, type RouteWaypoint } from '@zlayer/domain';
import { navigationRequestKey } from '../navigation/api';
import { fillMissingNavaidAlignment } from '../navigation/data';
import { useRouteResource } from './use-resource';
import { identifyRoutePoint, pointReplacementProblem, replaceIdentifiedPoint, selectRadialStation } from './identification';
import { routePointKeys } from './selection';
import { usePreviewPanel } from './use-preview-panel';
import type { RouteMapPreview, RoutePreviewInset } from './map-preview';
import './identification-picker.css';
import { useReferenceBearing } from './use-reference-bearing';

type IdentificationProps = {
  plan: RoutePlan; entry: RouteEntry; point?: RouteWaypoint | undefined;
  data?: NavigationData | undefined; catalog?: CatalogResponse | undefined;
  update: (edit: (draft: RouteDraft) => RouteDraft) => void;
  onPreviewChange?: ((preview: RouteMapPreview | undefined) => void) | undefined;
  inset?: RoutePreviewInset;
  navaids?: ReactNode;
  hasOriginalRadialStation?: boolean | undefined;
  onIdentify?: ((feature: GeoPointFeature, pointId?: string) => void) | undefined;
};
const NO_INSET = { right: 0, bottom: 0 };

/** Mounted only while the picker/ID panel is open; no background acquisition. */
function useIdentificationData(data: NavigationData | undefined, catalog: CatalogResponse | undefined) {
  const navaids = data?.navaids;
  const needsAlignment = useMemo(() => navaids?.features.some(feature => feature.properties.stationDeclinationDeg === undefined), [navaids]);
  const layer = catalog?.navigation.find(value => value.id === 'navaids');
  const key = needsAlignment && navaids && catalog ? JSON.stringify([navaids.meta,
    layer ? navigationRequestKey(layer, catalog.revision, []) : catalog.revision]) : undefined;
  const resource = useRouteResource(key, signal => fillMissingNavaidAlignment(navaids!.features, catalog!.revision, signal));
  return useMemo(() => resource.data && data && navaids ? { ...data, navaids: { ...navaids, features: resource.data } } : data,
    [data, navaids, resource.data]);
}

export function RadialStationPicker({ onClose, ...props }: IdentificationProps & {
  onClose: (restoreFocus?: boolean) => void;
}) {
  const data = useIdentificationData(props.data, props.catalog);
  const panel = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), title = useId();
  const inset = usePreviewPanel(true, panel, close, onClose);
  return <div ref={panel} className="route-preview-panel route-identification-picker" role="dialog" aria-labelledby={title}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <header><h2 id={title}>Choose reference point</h2>
      <button ref={close} type="button" className="ui-button" onClick={() => onClose()}>Close</button></header>
    <div className="route-identification-body"><RouteIdentificationChoices {...props} data={data} inset={inset} /></div>
  </div>;
}

export function RouteIdentificationChoices(props: IdentificationProps) {
  const { plan, entry, update } = props;
  const data = props.data;
  const points = useMemo(() => plan.waypoints.filter(point => point.source.entryId === entry.id), [plan, entry.id]);
  const point = props.point ?? points[0];
  const key = point ? routeIdentificationKey(point) : '';
  const coordinate = point?.feature.geometry.coordinates;
  const [candidate, setCandidate] = useState<GeoPointFeature>();
  useEffect(() => { setCandidate(undefined); }, [key, entry]);
  const named = useMemo(() => coordinate ? nearbyNamedRoutePoints(coordinate, data ?? {}) : [], [coordinate, data]);
  const definition = parseRadialDefinition(entry.text);
  const references = useMemo(() => definition ? radialReferenceCandidates(definition,
    Object.values(data ?? {}).flatMap(collection => collection.features)) : [], [definition?.station, definition?.bearing, data]);
  const magnetic = useReferenceBearing(props.catalog?.revision, !point && !!definition && definition.bearing !== 'true' &&
    definition.bearing !== 'radial' && (definition.bearing === 'magnetic' || references.some(feature => !isVorReference(feature))));
  const select = (form: RoutePointForm | undefined) => point && update(draft => identifyRoutePoint(draft, plan, point, form));
  const problem = point && pointReplacementProblem(plan, point);
  const { onPreviewChange, inset = NO_INSET } = props;
  useEffect(() => {
    if (!candidate || !point) { onPreviewChange?.(undefined); return; }
    const preview = emptyRoutePlan();
    const from: RouteWaypoint = { source: point.source, owners: [], ident: point.ident, layer: point.layer, feature: point.feature };
    const to: RouteWaypoint = { source: point.source, owners: [], ident: featureIdent(candidate), layer: 'fixes', feature: candidate };
    const a = from.feature.geometry.coordinates, b = to.feature.geometry.coordinates;
    preview.waypoints = [from, to];
    preview.legs = [{ from, to, owners: [], distanceNm: distanceNm(a, b), midpoint: geographicMidpoint(a, b) }];
    preview.distanceNm = preview.legs[0]!.distanceNm;
    onPreviewChange?.({ routes: [{ key: 'identification', plan: preview }], selectedKey: 'identification', inset });
    return () => onPreviewChange?.(undefined);
  }, [candidate, point, inset, onPreviewChange]);
  return <div className="route-identification-choices">
    {props.onIdentify && points.length > 1 && <label>Route point<select className="ui-input" value={key}
      onChange={event => {
        const next = points.find(value => routeIdentificationKey(value) === event.target.value);
        if (next) props.onIdentify?.(next.feature, routePointKeys(plan).get(next));
      }}>{points.map((value, index) =>
        <option key={index} value={routeIdentificationKey(value)}>{index + 1}. {value.ident}{value.approachPhase === 'missed' ? ' · Missed approach' : ''}</option>)}</select></label>}
    {!point && definition && <section><h3>Choose reference point</h3>
      <p>{entry.text}</p>
      {!references.length && <p role="status">Reference station data is unavailable.</p>}
      {references.map(feature => {
        const reference = referenceForDefinition(feature, definition, magnetic);
        return <button type="button" className="ui-button" key={featureKey(feature)} disabled={!reference}
          onClick={() => reference && update(draft => selectRadialStation(draft, entry,
            positionOnRadial(reference, definition.radial, definition.distanceNm)))}>
          {featureIdent(feature)} · {feature.properties.name} · {String(feature.properties.state ?? feature.properties.country ?? '')}
          {!reference && ' · Required magnetic alignment unavailable'}</button>;
      })}</section>}
    {!point && !definition && <p>No resolved position is available for this route item.</p>}
    {point && <>
      <p className="route-identification-current"><strong>{routePointLabel(point)}</strong></p>
      {point.radialReferenceCurrent === false &&
        <p>Saved reference; its original position and bearing alignment are retained.</p>}
      <section aria-label="Point description"><h3>Describe this position</h3>
        {point.feature.properties.kind !== 'coordinate' && <button type="button" className="ui-button"
          aria-pressed={!point.identification} onClick={() => select(undefined)}>Name · {point.ident}</button>}
        <button type="button" className="ui-button" aria-pressed={point.identification?.kind === 'coordinate' ||
          !point.identification && !point.radialPosition && point.feature.properties.kind === 'coordinate'}
          onClick={() => select({ kind: 'coordinate' })}>GPS coordinate</button>
        {point.radialPosition && !props.hasOriginalRadialStation && <button type="button" className="ui-button" aria-pressed={!point.identification}
          onClick={() => select(undefined)}>{point.radialPosition.reference.bearing ? 'Saved bearing' : 'Saved radial'} · {point.ident}</button>}
      </section>
      {props.navaids}
      <section aria-label="Nearby named points"><h3>Nearby named points</h3>
        <p>Choose a named point to move this route point to its location. The distance shown is how far it will move.</p>
        {problem && <p role="note">{problem}</p>}
        {named.map(value => <button type="button" className="ui-button" key={`${value.layer}:${featureKey(value.feature)}`}
          disabled={!!problem} onClick={() => setCandidate(value.feature)} aria-pressed={candidate === value.feature}>
          <strong>{featureIdent(value.feature)} · {value.offsetNm < .001 ? '<0.001' : value.offsetNm.toFixed(3)} NM offset</strong>
          <small>{value.feature.properties.name} · {value.layer}</small></button>)}
        {!named.length && <p>No named points within 5 NM in the loaded navigation data.</p>}
        {candidate && <div className="route-identification-confirm" role="group" aria-label="Confirm point replacement">
          <p>Replace {point.ident} with {featureIdent(candidate)}?</p>
          <button type="button" className="ui-button ui-button--primary" onClick={() => {
            update(draft => replaceIdentifiedPoint(draft, plan, point, candidate));
            props.onIdentify?.(candidate, point.edit?.entryId);
          }}>Use {featureIdent(candidate)}</button>
          <button type="button" className="ui-button ui-button--quiet" onClick={() => setCandidate(undefined)}>Cancel</button>
        </div>}
      </section>

    </>}
  </div>;
}
