import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type RefObject } from 'react';
import './panel-surface.css';

type PanelSurfaceProps = Omit<ComponentPropsWithoutRef<'dialog'>, 'open' | 'onCancel' | 'onClose'> & {
  /** Visibility belongs to the panel host; expansion intent belongs to the feature. */
  visible?: boolean;
  expanded: boolean;
  onExitFullScreen(): void;
  fullScreenButton: RefObject<HTMLButtonElement | null>;
  initialFocus?: RefObject<HTMLElement | null>;
};

/** One mounted body in inline and viewport-filling modes. Native modality keeps
 * the same DOM, reader/instrument state and nested-dialog behavior. */
export function PanelSurface({ visible = true, expanded, onExitFullScreen, fullScreenButton,
  initialFocus, className = '', children, onKeyDown, ...props }: PanelSurfaceProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef(false);
  const initiallyFocused = useRef(false);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (!visible) {
      if (dialog.matches(':modal')) dialog.close();
      return;
    }
    if (expanded) {
      dialog.close();
      dialog.showModal();
      fullScreenButton.current?.focus({ preventScroll: true });
    } else {
      if (previous.current) dialog.close();
      if (!dialog.open) dialog.setAttribute('open', '');
      if (previous.current) fullScreenButton.current?.focus({ preventScroll: true });
      else if (!initiallyFocused.current) initialFocus?.current?.focus({ preventScroll: true });
    }
    initiallyFocused.current = true;
    previous.current = expanded;
  }, [visible, expanded, fullScreenButton, initialFocus]);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    return () => dialog.close();
  }, []);
  return <dialog {...props} ref={ref} open className={`panel-surface ${className}${expanded ? ' is-fullscreen' : ''}`}
    aria-modal={visible && expanded || undefined}
    onCancel={event => {
      event.preventDefault(); event.stopPropagation();
      if (expanded) onExitFullScreen();
    }}
    onKeyDown={event => {
      if (expanded && event.key === 'Escape') event.stopPropagation();
      onKeyDown?.(event);
    }}>
    {children}
  </dialog>;
}

export function FullScreenButton({ expanded, button, iconSize = 20, className, onClick }: {
  expanded: boolean; button: RefObject<HTMLButtonElement | null>; onClick(): void;
  iconSize?: number; className?: string;
}) {
  const label = expanded ? 'Exit full screen' : 'Enter full screen';
  return <button ref={button} type="button" className={className} onClick={onClick}
    aria-label={label} title={label} aria-pressed={expanded}>
    <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={expanded
        ? 'M3 9h6V3m6 0v6h6M3 15h6v6m6 0v-6h6'
        : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} />
    </svg>
  </button>;
}
