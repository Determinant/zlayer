import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTerminalProceduresData, isTerminalProceduresResource } from '../src/terminal-procedures.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/terminal-procedures.json', import.meta.url), 'utf8'));

test('validates FAA SID/STAR topology, cycle, identity, point order, and manifest counts', () => {
  assert.equal(isTerminalProceduresData(fixture, '2026-09-03'), true);
  assert.equal(isTerminalProceduresData(fixture, '2026-10-01'), false);
  for (const mutate of [
    (data: typeof fixture) => { data.procedures.push(data.procedures[0]); },
    (data: typeof fixture) => { data.procedures[0].ident = 'NOTSPTNS'; },
    (data: typeof fixture) => { data.procedures[0].routes[0].points.reverse(); },
    (data: typeof fixture) => { data.procedures[0].routes[0].points[0].next = 3; },
    (data: typeof fixture) => { data.procedures[0].routes[0].airports[0].runway = 30; },
    (data: typeof fixture) => { data.procedures[0].routes[0].points = []; },
  ]) {
    const data = structuredClone(fixture);
    mutate(data);
    assert.equal(isTerminalProceduresData(data), false);
  }
  const resource = { id: 'terminal-procedures', title: 'SID/STAR routes', url: 'https://charts.test/terminal.json', count: 2, sourceCount: 2 };
  assert.equal(isTerminalProceduresResource(resource), true);
  assert.equal(isTerminalProceduresResource({ ...resource, count: 3 }), false);
});

test('airport associations contain individual identifiers, not unsplit lists', () => {
  const valid = structuredClone(fixture);
  valid.procedures[0].airports = ['SJC', 'SFO', 'OAK'];
  assert.equal(isTerminalProceduresData(valid), true);
  for (const ident of ['SJC SFO', 'SJC,SFO', 'SJC\tSFO', ' SJC ']) {
    const parent = structuredClone(fixture);
    parent.procedures[0].airports = [ident];
    assert.equal(isTerminalProceduresData(parent), false, ident);
    const body = structuredClone(fixture);
    body.procedures[0].routes[0].airports[0].ident = ident;
    assert.equal(isTerminalProceduresData(body), false, ident);
  }
});
