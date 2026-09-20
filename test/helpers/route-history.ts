import { readFileSync } from 'node:fs';
import type { RouteHistoryData, RouteHistoryResource } from '@zlayer/contracts';

export const { history, resource, revision } = JSON.parse(readFileSync(
  new URL('../fixtures/route-history.json', import.meta.url), 'utf8',
)) as { history: RouteHistoryData; resource: RouteHistoryResource; revision: string };
