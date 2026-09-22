import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep native modality and teardown paired; callers own content and dismissal. */
export function useModalDialog(open: boolean, initialFocus?: RefObject<HTMLElement | null>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.showModal();
    initialFocus?.current?.focus();
    return () => element.close();
  }, [open, initialFocus]);
  return dialog;
}
