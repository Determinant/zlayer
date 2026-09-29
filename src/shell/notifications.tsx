import { useId } from 'react';
import type { WorkspaceNotification } from './use-notifications';

export function NotificationBubbles({ notices, onDismiss }: {
  notices: WorkspaceNotification[];
  onDismiss(notice: WorkspaceNotification): void;
}) {
  const descriptionId = useId();
  return <div className="workspace-notices">
    {notices.map(notice => <div key={notice.id}
      className={`notification-bubble ${notice.tone === 'offline' ? 'offline-banner' : notice.tone === 'error' ? 'map-runtime-error' : 'feed-status'}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}>
      <button className="ui-button ui-button--quiet notification-dismiss" type="button"
        aria-label={`Dismiss ${notice.title}`} title="Dismiss · Review in Settings → Notifications"
        aria-describedby={`${descriptionId}-${notice.id}`}
        onClick={() => onDismiss(notice)}>
        <strong>{notice.title}</strong>
        <span id={`${descriptionId}-${notice.id}`}>{notice.message}</span>
        <small className="notification-dismiss-hint" aria-hidden="true">Tap to dismiss</small>
      </button>
      {notice.action && <div className="notification-actions"><button className="ui-button" type="button"
        disabled={notice.action.disabled} onClick={notice.action.run}>{notice.action.label}</button></div>}
    </div>)}
  </div>;
}

export function NotificationList({ notices }: { notices: WorkspaceNotification[] }) {
  return <section aria-labelledby="notifications-title">
    <h3 id="notifications-title">Notifications</h3>
    <p>Active notices stay here after you dismiss them from the map. Resolved notices disappear.</p>
    {notices.length ? <ul className="notification-list">{notices.map(notice => <li key={notice.id}>
      <h4>{notice.title}</h4><p>{notice.message}</p>
      {notice.action && <button className="ui-button" type="button" disabled={notice.action.disabled} onClick={notice.action.run}>{notice.action.label}</button>}
    </li>)}</ul> : <p>No active notifications.</p>}
  </section>;
}
