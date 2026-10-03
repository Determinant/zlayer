import type { WorkspaceNotification } from '../shell/use-notifications';
import type { PluginConnectionFailure } from '../core/layers/bridge';
import type { CatalogIssue } from './catalog/catalog';
import { navigationIssueMessages, type NavigationIssue } from '../layers/navigation/api';
import type { ChartCacheState } from '../layers/charts/use-cache';

type NotificationInputs = {
  connectionFailures: readonly PluginConnectionFailure[];
  pluginTitle(id: string): string;
  retryConnections(): void;
  regionError: string | undefined;
  visibleNavigationIssues: readonly NavigationIssue[];
  workspaceCycleNotice: string | undefined;
  online: boolean;
  chartsSelected: boolean;
  chartCacheState: ChartCacheState;
  retryChartCache(): void;
  feedIssues: readonly CatalogIssue[] | undefined;
  warning: { title: string; message: string } | undefined;
};

/** Keep notice wording, precedence and recovery actions together. */
export function workspaceNotifications({ connectionFailures, pluginTitle, retryConnections, regionError,
  visibleNavigationIssues, workspaceCycleNotice, online, chartsSelected, chartCacheState,
  retryChartCache, feedIssues, warning }: NotificationInputs): WorkspaceNotification[] {
  const notices: WorkspaceNotification[] = [];
  if (connectionFailures.length) notices.push({ id: 'connections', title: 'Workspace connection unavailable', tone: 'error',
    message: connectionFailures.map(failure => `${pluginTitle(failure.providerId)}: ${failure.message}`).join('; '),
    action: { label: 'Retry workspace connections', run: retryConnections } });
  if (regionError) notices.push({ id: 'regions', title: 'Saved downloads', message: regionError });
  if (visibleNavigationIssues.length) notices.push({ id: 'navigation', title: 'Navigation data unavailable',
    message: `${navigationIssueMessages(visibleNavigationIssues).join(' ')} Reconnect or repair the affected download.` });
  if (workspaceCycleNotice) notices.push({ id: 'cycle', title: 'FAA data cycle', message: workspaceCycleNotice });
  if (!online) notices.push({ id: 'offline', title: 'Offline', tone: 'offline',
    message: 'Saved content remains available. Uncached areas are unavailable; weather may be stale.' });
  if (chartsSelected && chartCacheState === 'unavailable') notices.push({ id: 'chart-cache', title: 'Charts are disabled', tone: 'error',
    message: 'A controlling service worker is required for whole-file MBTiles caching.',
    action: { label: 'Retry chart cache', run: retryChartCache } });
  if (feedIssues?.length) notices.push({ id: 'feeds', title: 'Feed issues',
    message: feedIssues.map(issue => `${issue.product}: ${issue.message}`).join(' '),
    action: { label: 'Reload feeds', run: () => window.location.reload() } });
  if (warning) notices.push({ id: 'resource', title: warning.title, message: warning.message, tone: 'error' });
  return notices;
}
