import type { FeatureDetailRow } from './feature-details';

export function AirportFrequencyValue({ label, value, notes }: Pick<FeatureDetailRow, 'label' | 'value' | 'notes'>) {
  const channels = <span className="airport-frequency-value">
    {value.split('\n').map(line => {
      const [channel, ...context] = line.split(' · ');
      return <span className="airport-frequency-channel" key={line}>
        <span className="airport-frequency-number">{channel!.replace(/ MHz$/, '')}<span className="airport-frequency-unit"> MHz</span></span>
        {context.length > 0 && <span className="airport-frequency-context"> · {context.join(' · ')}</span>}
      </span>;
    })}
  </span>;
  return notes?.length ? <details className="airport-frequency-notes">
    <summary role="button" aria-label={`${label}: ${value}. Hours and notes`} title="Hours and notes">
      {channels}
      <svg className="airport-frequency-chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </summary>
    <section className="airport-frequency-note-list" aria-label={`${label} notes`}>
      {notes.map(note => <p key={note}>{note}</p>)}
    </section>
  </details> : channels;
}
