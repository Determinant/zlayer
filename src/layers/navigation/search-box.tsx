import type { GeoPointFeature, NavigationLayerId, SearchResult } from '@zlayer/contracts';
import { featureIdent, featureKey, featureSubtitle } from '@zlayer/domain';
import { navigationIssueMessages, type NavigationIssue } from './api';
import { useRef } from 'react';
import { useBackDismiss } from '../../core/ui/pwa-back';

type SearchBoxProps = {
  query: string;
  results: SearchResult[];
  loading?: boolean;
  unavailable?: NavigationLayerId[];
  issues?: NavigationIssue[];
  onQueryChange: (query: string) => void;
  onSelect: (feature: GeoPointFeature) => void;
};

export function SearchBox({ query, results, loading = false, unavailable = [], issues = [], onQueryChange, onSelect }: SearchBoxProps) {
  const root = useRef<HTMLDivElement>(null);
  useBackDismiss(!!query, root, () => onQueryChange(''));
  return (
    <div ref={root} className="search">
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Airport, fix, or NAVAID"
        aria-label="Search FAA navigation data"
      />
      {query && (
        <button
          className="clear-button"
          type="button"
          onClick={() => onQueryChange('')}
          aria-label="Clear search"
        >
          ×
        </button>
      )}
      {(loading || results.length > 0 || unavailable.length > 0 || issues.length > 0) && (
        <div className="search-results">
          {loading && <p className="search-status" role="status">
            {results.length ? 'Loading more results…' : 'Searching…'}
          </p>}
          {issues.length > 0 ? <p className="search-warning" role="status">
            Partial results: {navigationIssueMessages(issues).join(' ')} Reconnect or repair the affected download.
          </p> : unavailable.length > 0 && <p className="search-warning" role="status">
            Partial results: {unavailable.join(', ')} unavailable. Reconnect to load missing data.
          </p>}
          {results.map((result) => (
            <button
              key={`${result.layer}-${featureKey(result.feature)}`}
              type="button"
              onClick={() => onSelect(result.feature)}
            >
              <span className={`result-glyph is-${result.layer}`} />
              <span className="search-result-copy">
                <strong>{featureIdent(result.feature)}</strong>
                <em>{result.layer.replace('-', ' ')}</em>
                <small>{featureSubtitle(result.feature)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
