import { useEffect, useState } from 'react';

export interface WorkspaceNotification {
  id: string;
  title: string;
  message: string;
  tone?: 'offline' | 'error';
  action?: { label: string; run(): void; disabled?: boolean };
}
function identity(notice: WorkspaceNotification) {
  return JSON.stringify([notice.id, notice.title, notice.message]);
}

/** Dismissal belongs to the current occurrence, never to the underlying condition. */
export function useNotifications(notices: WorkspaceNotification[]) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const active = JSON.stringify(notices.map(identity));
  useEffect(() => {
    const keys = new Set<string>(JSON.parse(active));
    setDismissed(previous => {
      const retained = [...previous].filter(key => keys.has(key));
      return retained.length === previous.size ? previous : new Set(retained);
    });
  }, [active]);
  return {
    notices,
    visible: notices.filter(notice => !dismissed.has(identity(notice))),
    dismiss: (notice: WorkspaceNotification) => setDismissed(previous => new Set([...previous, identity(notice)])),
  };
}
