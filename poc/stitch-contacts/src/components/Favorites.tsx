import type { JSX } from 'react';
import { ArrowUpRight, Star } from 'lucide-react';
import { ui } from '../data/mockData';
import type { Contact } from '../types';
import { Avatar } from './Avatar';

interface FavoritesProps {
  readonly contacts: readonly Contact[];
  readonly onSelect: (contact: Contact) => void;
  readonly onViewAll: () => void;
}

export function Favorites({ contacts, onSelect, onViewAll }: FavoritesProps): JSX.Element {
  return (
    <section className="favorites-section" aria-label={ui.frequentContacts}>
      <div className="section-heading">
        <h2>
          <Star size={17} />
          {ui.frequentContacts}
        </h2>
        <button className="button button-quiet" onClick={onViewAll}>
          {ui.viewFavorites}
          <ArrowUpRight size={16} />
        </button>
      </div>

      {contacts.length ? (
        <div className="favorites-grid">
          {contacts.slice(0, 4).map(contact => (
            <button
              className="favorite-card"
              key={contact.id}
              onClick={() => onSelect(contact)}
            >
              <Avatar contact={contact} />
              <span className="favorite-name">{contact.name}</span>
              <span className="favorite-role">{contact.role || contact.group}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="privacy-note">{ui.emptyFavorites}</p>
      )}
    </section>
  );
}
