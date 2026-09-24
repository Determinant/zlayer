import { useLayoutEffect, useRef } from 'react';

/** Content tabs keep selection and panel lifetime with their owner. */
export function TabList<T extends string>({ id, label, tabs, value, onChange, className = '', scrollable = false, size = 'compact' }: {
  id: string;
  label: string;
  tabs: readonly { value: T; label: string; accessibleLabel?: string; active?: boolean; description?: string }[];
  value: NoInfer<T> | undefined;
  onChange(value: NoInfer<T>): void;
  className?: string;
  scrollable?: boolean;
  size?: 'compact' | 'slim';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const rail = ref.current;
    if (!scrollable || !rail) return;
    const reveal = () => {
      const selected = rail.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected) return;
      const r = rail.getBoundingClientRect(), b = selected.getBoundingClientRect();
      // Scroll only this rail. scrollIntoView can move the enclosing toolbox/page.
      if (b.left < r.left + 3) rail.scrollLeft -= r.left + 3 - b.left;
      else if (b.right > r.right - 3) rail.scrollLeft += b.right - r.right + 3;
    };
    const edges = () => {
      rail.dataset.overflowStart = String(rail.scrollLeft > 2);
      rail.dataset.overflowEnd = String(rail.scrollWidth - rail.clientWidth - rail.scrollLeft > 2);
    };
    const resize = () => { reveal(); edges(); };
    const observer = new ResizeObserver(resize); observer.observe(rail);
    for (const button of rail.children) observer.observe(button);
    rail.addEventListener('scroll', edges, { passive: true }); resize();
    return () => { observer.disconnect(); rail.removeEventListener('scroll', edges); };
  }, [value, scrollable]);
  return <div ref={ref} className={`ui-tabs${scrollable ? ' ui-tabs--scrollable panel-scroll' : ''} ${className}`} role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.value} type="button"
      className={`ui-button ui-button--quiet ui-button--${size}`} role="tab"
      id={`${id}-${tab.value}-tab`} aria-controls={`${id}-${tab.value}-panel`}
      aria-label={tab.accessibleLabel} data-active={tab.active || undefined} aria-description={tab.description}
      aria-selected={value === tab.value} tabIndex={value === tab.value || value === undefined && index === 0 ? 0 : -1}
      onClick={() => onChange(tab.value)} onKeyDown={event => {
        let next: number;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus({ preventScroll: scrollable });
        onChange(tabs[next]!.value);
      }}>{tab.label}</button>)}
  </div>;
}

export function tabPanelProps(id: string, value: string, selected: string | undefined) {
  return { role: 'tabpanel', id: `${id}-${value}-panel`, 'aria-labelledby': `${id}-${value}-tab`, hidden: selected !== value } as const;
}
