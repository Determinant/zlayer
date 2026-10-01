import { airportFrequencyLabel, type AirportFrequencyChannel, type AirportFrequencyDisplay } from './airport-frequencies';

function FrequencyChannel({ channel }: { channel: AirportFrequencyChannel }) {
  return <span className="airport-frequency-channel">
    <span className="airport-frequency-number">{channel.number}<span className="airport-frequency-unit"> MHz</span></span>
    {channel.context.length > 0 && <span className="airport-frequency-context"> · {channel.context.join(' · ')}</span>}
  </span>;
}

export function AirportFrequencyValue({ label, frequency }: { label: string; frequency: AirportFrequencyDisplay }) {
  const { channels, notes } = frequency;
  const value = <span className="airport-frequency-value">
    {channels.map(channel => <FrequencyChannel key={JSON.stringify(channel)} channel={channel} />)}
  </span>;
  return notes.length ? <details className="airport-frequency-notes">
    <summary role="button" aria-label={`${label}: ${channels.map(airportFrequencyLabel).join('\n')}. Hours and notes`} title="Hours and notes">
      {value}
      <svg className="airport-frequency-chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6 4 4 4-4" />
      </svg>
    </summary>
    <section className="airport-frequency-note-list" aria-label={`${label} notes`}>
      {notes.map(note => <div className="airport-frequency-note" key={JSON.stringify(note)}>
        {note.channel && <FrequencyChannel channel={note.channel} />}
        {note.text.length > 0 && <p>{note.text.join(' · ')}</p>}
      </div>)}
    </section>
  </details> : value;
}
