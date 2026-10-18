import type { JSX } from 'react';
import { ArrowDownAZ, ChevronRight, SearchX, Star } from 'lucide-react';
import { ui } from '../data/mockData';
import type { Contact } from '../types';
import { Avatar } from './Avatar';

interface ContactListProps {
  readonly contacts: readonly Contact[];
  readonly selectedId: string | null;
  readonly onSelect: (contact: Contact) => void;
  readonly onToggleFavorite: (id: string) => void;
  readonly onClear: () => void;
}

export function ContactList({
  contacts,
  selectedId,
  onSelect,
  onToggleFavorite,
  onClear,
}: ContactListProps): JSX.Element {
  return (
    <section className="contacts-section" aria-label={ui.contactsLabel}>
      <div className="list-toolbar">
        <h2>
          {ui.contactsLabel}
          <span className="list-count">{contacts.length}</span>
        </h2>
        <span>
          <ArrowDownAZ size={16} />
          {ui.sortLabel}
        </span>
      </div>
      <div className="list-heading">
        <span>{ui.nameColumn}</span>
        <span>{ui.companyColumn}</span>
        <span>{ui.groupColumn}</span>
      </div>

      {contacts.length ? (
        <ul className="contact-list">
          {contacts.map(contact => (
            <li
              key={contact.id}
              className={`contact-row ${
                contact.id === selectedId ? 'is-selected' : ''
              }`}
            >
              <button
                className="contact-main"
                onClick={() => onSelect(contact)}
                aria-label={`${ui.selectContact} ${contact.name}`}
                aria-pressed={contact.id === selectedId}
              >
                <Avatar contact={contact} size="small" />
                <span className="contact-copy">
                  <span className="contact-name">{contact.name}</span>
                  <span className="contact-subtitle">
                    {contact.role || contact.phone || contact.email}
                  </span>
                </span>
                <span className="contact-company">
                  {contact.company || ui.noCompany}
                </span>
                <span className="contact-group">
                  <span className="group-badge">{contact.group}</span>
                </span>
                <ChevronRight className="contact-trailing" size={18} />
              </button>
              <button
                className={`star-button ${contact.favorite ? 'is-favorite' : ''}`}
                onClick={() => onToggleFavorite(contact.id)}
                aria-label={`${contact.favorite ? ui.unfavorite : ui.favorite} ${
                  contact.name
                }`}
                aria-pressed={contact.favorite}
              >
                <Star size={18} fill={contact.favorite ? 'currentColor' : 'none'} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          <SearchX size={36} />
          <h3>{ui.emptyTitle}</h3>
          <p>{ui.emptyDescription}</p>
          <button className="button button-secondary" onClick={onClear}>
            {ui.clearFilters}
          </button>
        </div>
      )}
    </section>
  );
}
