import { readFileSync } from 'node:fs';
import type { RouteHistoryData, RouteHistoryResource } from '../../src/index.js';

export const { history, resource, revision } = JSON.parse(readFileSync(
  new URL('../../../../test/fixtures/route-history.json', import.meta.url), 'utf8',
)) as { history: RouteHistoryData; resource: RouteHistoryResource; revision: string };
