import { useCallback, useEffect, useRef, useState } from 'react';
import { externalErrorCode, type ResourceErrorCode } from '../core/data/errors';

type WarningTitle = 'Map layer unavailable' | 'Chart unavailable';
type ResourceWarning = { title: WarningTitle; message: string; key: string };

export function useResourceWarning(online: boolean) {
  const [warning, setWarning] = useState<ResourceWarning>();
  const dismissed = useRef(new Set<string>());

  const report = useCallback((title: WarningTitle, message: string, code?: ResourceErrorCode) => {
    const category = code ?? externalErrorCode(message);
    const key = category === 'request' || category === 'http' ? 'request' : `${title}:${message}`;
    if (dismissed.current.has(key) || (key === 'request' && !navigator.onLine)) return;
    setWarning(current => {
      // A stream of failed tiles must not obscure a storage/integrity failure.
      if (current && (current.key === key || (current.key !== 'request' && key === 'request'))) return current;
      return { title, message, key };
    });
  }, []);
  const clear = useCallback((title?: WarningTitle) => {
    setWarning(current => !title || current?.title === title ? undefined : current);
  }, []);
  const dismiss = () => {
    if (warning) dismissed.current.add(warning.key);
    setWarning(undefined);
  };

  useEffect(() => {
    if (!online) setWarning(current => current?.key === 'request' ? undefined : current);
  }, [online]);

  return {
    warning: !online && warning?.key === 'request' ? undefined : warning,
    report, clear, dismiss,
  };
}
