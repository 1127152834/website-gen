import type { JSX } from 'react';
import { Search, X } from 'lucide-react';
import { ui } from '../data/mockData';

interface SearchBarProps {
  readonly query: string;
  readonly onQuery: (value: string) => void;
}

export function SearchBar({ query, onQuery }: SearchBarProps): JSX.Element {
  return (
    <div className="search-bar">
      <Search size={20} aria-hidden="true" />
      <input
        className="search-input"
        type="search"
        aria-label={ui.searchLabel}
        placeholder={ui.searchPlaceholder}
        value={query}
        onChange={event => onQuery(event.target.value)}
      />
      {query && (
        <button
          className="icon-button clear-search"
          onClick={() => onQuery('')}
          aria-label={ui.clearSearch}
        >
          <X size={18} />
        </button>
      )}
    </div>
  );
}
