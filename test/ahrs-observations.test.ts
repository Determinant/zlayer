import assert from 'node:assert/strict';
import test from 'node:test';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { cholesky, solve } from '../src/layers/ahrs/estimator/linalg';
import type { ObservationListener } from '../src/layers/ahrs/estimator/types';
import { turn } from './helpers/ahrs-motion';

test('velocity and altitude diagnostics keep their own innovations, dimensions and rejection results', () => {
  const observations: Parameters<ObservationListener>[0][] = [];
  const filter = new Ahrs({ gravityAiding: false, gpsVelocityStd: .1 }, observation => observations.push(observation));
  filter.update(turn(0).sample); filter.alignHeading(0);
  for (let i = 1; i <= 4 * 50; i++) {
    const time = i / 50, truth = turn(time);
    filter.update(truth.sample);
    if (i % 50 === 0) filter.updateGps({ ...truth.fix, track: truth.fix.track! + (time === 4 ? 90 : 0),
      altitude: 1000, altitudeAccuracy: 5 });
  }
  const latest = observations.filter(value => value.time === 4);
  assert.deepEqual(latest.map(value => [value.source, value.dimension, value.result]),
    [['velocity', 2, 'innovation'], ['altitude', 1, 'accepted']]);
  const state = filter.getState(4);
  assert.equal(state.fusion.accepted, 3);
  assert.equal(state.fusion.rejected, 1);
  assert.equal(state.altitudeFusion.accepted, 4);
  assert.equal(state.fusion.nis, latest[0]!.nis);
  assert.equal(state.altitudeFusion.nis, latest[1]!.nis);
  for (const observation of observations) {
    if (!observation.covariance) { assert.equal(observation.result, 'initialized'); continue; }
    const L = cholesky(new Float64Array(observation.covariance), observation.dimension)!;
    assert.ok(L);
    const weighted = solve(L, observation.residual, observation.dimension);
    const nis = observation.residual.reduce((sum, x, i) => sum + x * weighted[i]!, 0);
    assert.ok(Math.abs(nis - observation.nis!) < 1e-10);
  }
});

test('out-of-order fusion reports replay revisions using stable source/acquisition times', () => {
  const observations: Parameters<ObservationListener>[0][] = [];
  const filter = new Ahrs({ gravityAiding: false }, observation => observations.push(observation));
  filter.update(turn(0).sample); filter.alignHeading(0);
  for (let i = 1; i <= 3 * 50; i++) filter.update(turn(i / 50).sample);
  filter.updateGps(turn(1).fix); filter.updateGps(turn(3).fix);
  filter.updateGps(turn(2).fix);
  assert.deepEqual(observations.map(value => [value.time, value.replayed]), [[1, false], [3, false], [2, false], [3, true]]);
  const final = new Map(observations.map(value => [`${value.source}:${value.time}`, value]));
  assert.equal(final.size, 3, 'a replayed observation replaces its previous innovation');
});
