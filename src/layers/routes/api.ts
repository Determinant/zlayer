import type { PreferredRoutesData, PreferredRoutesResource } from '@zlayer/contracts';
import type { TerminalProceduresData, TerminalProceduresResource } from '@zlayer/contracts';
import { fetchJson } from '../../core/data/fetch-json';
import { preferredRoutesDocumentGuard, terminalProceduresDocumentGuard } from '../../core/data/references';
import { ResourceCache } from '../../core/data/resource-cache';

const cache = new ResourceCache<PreferredRoutesData>();
const terminalCache = new ResourceCache<TerminalProceduresData>();

export function fetchTerminalProcedures(resource: TerminalProceduresResource, revision: string): Promise<TerminalProceduresData> {
  const key = JSON.stringify([revision, resource]);
  return terminalCache.get(key, () => fetchJson(resource.url, terminalProceduresDocumentGuard(resource, revision), 'FAA SID/STAR routes', { cacheOnly: !!resource.cacheOnly }));
}

export function fetchPreferredRoutes(resource: PreferredRoutesResource, revision: string): Promise<PreferredRoutesData> {
  const key = JSON.stringify([revision, resource]);
  return cache.get(key, () => fetchJson(resource.url,
    preferredRoutesDocumentGuard(resource, revision),
    'FAA preferred routes',
    { cacheOnly: !!resource.cacheOnly },
  ));
}
