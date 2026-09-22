/** Content tabs keep selection and panel lifetime with their owner. */
export function TabList<T extends string>({ id, label, tabs, value, onChange, className = '' }: {
  id: string;
  label: string;
  tabs: readonly { value: T; label: string }[];
  value: NoInfer<T> | undefined;
  onChange(value: NoInfer<T>): void;
  className?: string;
}) {
  return <div className={`ui-tabs ${className}`} role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.value} type="button"
      className="ui-button ui-button--quiet ui-button--compact" role="tab"
      id={`${id}-${tab.value}-tab`} aria-controls={`${id}-${tab.value}-panel`}
      aria-selected={value === tab.value} tabIndex={value === tab.value || value === undefined && index === 0 ? 0 : -1}
      onClick={() => onChange(tab.value)} onKeyDown={event => {
        let next: number;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        onChange(tabs[next]!.value);
      }}>{tab.label}</button>)}
  </div>;
}

export function tabPanelProps(id: string, value: string, selected: string | undefined) {
  return { role: 'tabpanel', id: `${id}-${value}-panel`, 'aria-labelledby': `${id}-${value}-tab`, hidden: selected !== value } as const;
}
