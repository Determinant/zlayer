import { createHash } from 'node:crypto';
import type { NotamFeedStatus } from '@zlayer/contracts';
import type { assessInfoHealth } from './health';
import { formatCheckedAt, formatTimestamp } from '../../src/core/format/time';
import { loadStatusStyles } from './status-style';

// The server build embeds the same assets that development reads from core.
declare const __INFO_STATUS_STYLES__: string;

type Readiness = ReturnType<typeof assessInfoHealth>;
/** Health probes default to JSON; only an explicit HTML preference opens the UI. */
export function prefersStatusPage(accept = ''): boolean {
  const types = new Map(accept.split(',').map(part => {
    const [type, ...parameters] = part.trim().toLowerCase().split(';');
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.slice(2));
    return [type!.trim(), Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0];
  }));
  const html = types.get('text/html') ?? 0;
  const json = types.get('application/json') ?? types.get('application/*') ?? types.get('*/*') ?? 0;
  return html > 0 && html >= json;
}
const names: Record<string, string> = { clouds: 'Clouds', icing: 'Icing', winds: 'Winds',
  'progs.analysis': 'Surface analysis', 'progs.forecast': 'Surface forecast', 'progs.coverage': 'Chart coverage',
  radar: 'Radar', radarMotion: 'Storm motion', 'advisory.gairmet': 'G-AIRMETs', 'advisory.sigmet': 'SIGMETs',
  'advisory.cwa': 'CWAs', pireps: 'Pilot reports', tfrs: 'TFRs', notams: 'NOTAMs', 'notams.reconciliation': 'NOTAM full sync' };
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);
const label = (product: string) => names[product] ?? product;
const style = `
${typeof __INFO_STATUS_STYLES__ === 'undefined' ? loadStatusStyles() : __INFO_STATUS_STYLES__}
:root{color:var(--text-primary);background:var(--surface-dialog)}
body{max-width:640px;margin:24px auto;padding:0 12px}
header,nav,footer{display:flex;align-items:center;gap:var(--ui-panel-gap)}
header,footer{justify-content:space-between}header{margin-bottom:var(--ui-panel-gap)}
nav{gap:var(--ui-space-related)}nav a{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
a{color:var(--text-action);text-underline-offset:3px}a:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
main,#connection{padding:var(--ui-panel-padding);border:1px solid var(--border-subtle);border-radius:var(--ui-panel-radius);background:var(--surface-panel)}
.summary{margin-bottom:var(--ui-panel-gap)}.summary p{margin-top:var(--ui-space-related)}
.good{color:var(--text-83e0c4)}.warn{color:var(--text-ffd17a)}.bad{color:var(--text-ffd0ca)}
.ui-data-table th:first-child{width:50%}.ui-data-table td:nth-child(2){white-space:nowrap}
.ui-data-table :where(th,td){vertical-align:top;overflow-wrap:anywhere}.detail{display:block;margin-top:2px}
.ui-data-table tbody tr:last-child :where(th,td){border-bottom:0}
footer{align-items:flex-start;flex-wrap:wrap;margin-top:var(--ui-panel-gap)}footer a{min-height:32px;display:inline-flex;align-items:center}
#connection{margin:0}[hidden]{display:none!important}noscript p{margin:0 0 var(--ui-panel-gap)}
@media(max-width:480px){body{margin:12px auto}}
@media(prefers-color-scheme:light){:root{color-scheme:light}}
`;

// Refresh server-rendered HTML so the page never duplicates readiness policy.
// Hide the previous snapshot on failure or when a suspended tab becomes stale.
export const statusRefreshScript = `
(() => {
  let pending = false, checked = performance.now();
  const connection = document.getElementById('connection');
  function unavailable(message) {
    document.getElementById('snapshot').hidden = true;
    connection.hidden = false;
    connection.textContent = message;
    document.title = 'Status unavailable | ZLayer';
  }
  async function refresh() {
    if (pending || document.hidden) return;
    pending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/weather/healthz', { headers: { Accept: 'text/html' }, cache: 'no-store', signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) throw new Error('Unavailable');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const snapshot = page.getElementById('snapshot');
      if (!snapshot || snapshot.dataset.infoStatus !== '1') throw new Error('Invalid status page');
      if (snapshot.dataset.infoVersion !== document.getElementById('snapshot').dataset.infoVersion) {
        window.location.reload(); return;
      }
      document.getElementById('snapshot').replaceWith(snapshot);
      document.getElementById('updated').replaceWith(page.getElementById('updated'));
      document.title = page.title;
      connection.hidden = true;
      checked = performance.now();
    } catch {
      unavailable('Status unavailable. Could not refresh the server status. Retrying every 30 seconds.');
    } finally { clearTimeout(timeout); pending = false; }
  }
  function stale() {
    if (performance.now() - checked > 45000) unavailable('Status is out of date. Waiting for a fresh server response.');
  }
  setInterval(refresh, 30000);
  setInterval(stale, 1000);
  document.addEventListener('visibilitychange', () => { stale(); if (!document.hidden) void refresh(); });
  window.addEventListener('offline', () => unavailable('You are offline. Current server status is unavailable.'));
  window.addEventListener('online', refresh);
  window.addEventListener('pageshow', event => { if (event.persisted) { unavailable('Checking current server status…'); void refresh(); } });
})();
`;
const hash = (value: string) => createHash('sha256').update(value).digest('base64');
const pageVersion = hash(style + statusRefreshScript);
export const statusPagePolicy = `default-src 'none'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(statusRefreshScript)}'; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

export function renderStatusPage(readiness: Readiness, notams: NotamFeedStatus, now: number, source?: string): string {
  const kind = !readiness.ready ? 'bad' : readiness.warnings.length ? 'warn' : 'good';
  const title = !readiness.ready ? 'Needs attention' : readiness.warnings.length ? 'Ready with warnings' : 'Healthy';
  const problems = [...readiness.problems, ...readiness.warnings];
  const rows = Object.entries(readiness.sources).map(([product, value]) => {
    const applies = (problem: Readiness['problems'][number]) => problem.product === product || problem.product.startsWith(product + '.');
    const blocked = readiness.problems.some(applies);
    const warning = readiness.warnings.some(applies);
    const state = !value.available ? 'Unavailable' : !value.fresh ? 'Stale' : value.error || blocked ? 'Attention' : warning ? 'Warning' : 'Ready';
    const color = !value.available || !value.fresh || value.error || blocked ? 'bad' : warning ? 'warn' : 'good';
    const details = [...new Set([...(value.error ? [value.error] : []), ...problems.filter(applies).map(problem =>
      problem.product === product ? problem.reason : `${label(problem.product)}: ${problem.reason}`),
      ...(value.coverage === 'partial' ? ['Partial coverage'] : value.coverage === 'unknown' ? ['Coverage unknown'] : [])])];
    const checked = value.checkedAt === null ? '—' : formatCheckedAt(value.checkedAt, now).replace(/^Checked /, '');
    return `<tr><th scope="row">${escape(label(product))}${details.length ? `<small class="ui-meta detail">${escape(details.join(' · '))}</small>` : ''}</th>
      <td class="${color}">${state}</td><td class="ui-meta" title="${escape(formatTimestamp(value.checkedAt, { now }))}">${escape(checked)}</td></tr>`;
  }).join('');
  const conflicts = notams.enabled ? `${notams.unresolvedRecords ?? 0} unresolved NOTAMs · ${notams.blockingRecords ?? notams.unresolvedRecords ?? 0} blocking` : 'NOTAM collection disabled';
  const sourceLink = source && /^https?:\/\//.test(source) ? `<a href="${escape(source)}">Source code</a>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title} | ZLayer</title><style>${style}</style></head>
<body><header><div><h1 class="ui-panel-title">Info server</h1><span class="ui-meta">ZLayer</span></div><nav aria-label="Status links"><a class="ui-button ui-button--compact" href="/api/weather/healthz?format=json">JSON</a><a class="ui-button ui-button--compact" href="/api/weather/healthz">Refresh</a></nav></header>
<p id="connection" class="ui-note" role="status" hidden></p><noscript><p class="ui-note">Automatic refresh requires JavaScript. Use Refresh for a current snapshot.</p></noscript>
<main id="snapshot" data-info-status="1" data-info-version="${pageVersion}"><section class="summary" aria-label="Overall status"><h2 class="ui-panel-title ${kind}">${title}</h2>
<p class="ui-meta">${conflicts}</p></section><table class="ui-data-table" aria-label="Source status"><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Checked</th></tr></thead>
<tbody>${rows}${!notams.enabled ? '<tr><th scope="row">NOTAMs</th><td class="ui-meta">Disabled</td><td class="ui-meta">—</td></tr>' : ''}</tbody></table></main>
<footer id="updated" class="ui-meta"><div>Updated ${formatTimestamp(now, { now })}<br>Refreshes every 30 seconds</div>${sourceLink}</footer>
<script data-cfasync="false">${statusRefreshScript}</script></body></html>`;
}
