import { formatMetarAge } from './format';

const CATEGORIES = [
  { id: 'vfr', label: 'VFR' },
  { id: 'mvfr', label: 'MVFR' },
  { id: 'ifr', label: 'IFR' },
  { id: 'lifr', label: 'LIFR' },
  { id: 'unknown', label: 'N/A' },
] as const;

type FlightCategoryLegendProps = {
  observedAt: string | undefined;
};

export function FlightCategoryLegend({ observedAt }: FlightCategoryLegendProps) {
  return (
    <div className="flight-category-legend" aria-label="METAR flight categories">
      {CATEGORIES.map((category) => (
        <span key={category.id} className={`is-${category.id}`}>
          <i />{category.label}
        </span>
      ))}
      <small>{formatMetarAge(observedAt)}</small>
    </div>
  );
}
