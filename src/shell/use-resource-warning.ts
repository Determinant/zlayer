import { useCallback, useEffect, useState } from 'react';
import { externalErrorCode, type ResourceErrorCode } from '../core/data/errors';

type WarningTitle = 'Map layer unavailable' | 'Chart unavailable';
type ResourceWarning = { title: WarningTitle; message: string; key: string; resource: string; dismissalKey?: string };

export function useResourceWarning(online: boolean) {
  const [warnings, setWarnings] = useState<readonly ResourceWarning[]>([]);

  const report = useCallback((title: WarningTitle, message: string, code?: ResourceErrorCode, resource = message) => {
    const category = code ?? externalErrorCode(message);
    const key = category === 'request' || category === 'http' ? 'request' : `${title}:${message}`;
    if (key === 'request' && !navigator.onLine) return;
    setWarnings(current => {
      if (current.some(warning => warning.title === title && warning.resource === resource && warning.key === key)) return current;
      const warning = { title, message, key, resource, ...(key === 'request' ? { dismissalKey: 'request' } : {}) };
      // Map callers use source IDs, not tile URLs/messages: retain one warning
      // per live source while one resource recovering cannot hide another.
      // The bubble stays grouped; storage/integrity failures take precedence.
      return key === 'request' ? [...current, warning]
        : [warning, ...current.filter(warning => warning.key === 'request')];
    });
  }, []);
  const clear = useCallback((title?: WarningTitle) => {
    setWarnings(current => title ? current.filter(warning => warning.title !== title) : []);
  }, []);
  const recover = useCallback((title: WarningTitle, resource: string) => {
    setWarnings(current => {
      const retained = current.filter(warning => warning.key !== 'request' || warning.title !== title || warning.resource !== resource);
      return retained.length === current.length ? current : retained;
    });
  }, []);

  useEffect(() => {
    if (!online) setWarnings(current => current.filter(warning => warning.key !== 'request'));
  }, [online]);

  return {
    warning: warnings.find(warning => online || warning.key !== 'request'),
    report, clear, recover,
  };
}
