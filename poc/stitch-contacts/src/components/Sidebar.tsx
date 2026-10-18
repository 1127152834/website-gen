import type { JSX } from 'react';
import { ChevronRight, ContactRound, ShieldCheck, Star, Users } from 'lucide-react';
import { groups, ui } from '../data/mockData';
import type { Contact, ContactFilter } from '../types';

interface SidebarProps {
  readonly contacts: readonly Contact[];
  readonly filter: ContactFilter;
  readonly onFilter: (filter: ContactFilter) => void;
  readonly onHome: () => void;
}

export function Sidebar({
  contacts,
  filter,
  onFilter,
  onHome,
}: SidebarProps): JSX.Element {
  return (
    <aside className="sidebar">
      <button className="brand" onClick={onHome} aria-label={ui.allContacts}>
        <span className="brand-mark">
          <ContactRound size={24} />
        </span>
        <span>
          <strong className="brand-name">{ui.appName}</strong>
          <span className="brand-caption">{ui.appEnglish}</span>
        </span>
      </button>

      <div className="nav-section-label">{ui.workspaceLabel}</div>
      <nav className="nav-list" aria-label={ui.contactsLabel}>
        <button
          className={`nav-button ${filter === 'all' ? 'is-active' : ''}`}
          onClick={() => onFilter('all')}
          aria-current={filter === 'all' ? 'page' : undefined}
        >
          <Users size={19} />
          <span>{ui.allContacts}</span>
          <span className="nav-count">{contacts.length}</span>
        </button>
        <button
          className={`nav-button ${filter === 'favorites' ? 'is-active' : ''}`}
          onClick={() => onFilter('favorites')}
          aria-current={filter === 'favorites' ? 'page' : undefined}
        >
          <Star size={19} />
          <span>{ui.favorites}</span>
          <span className="nav-count">
            {contacts.filter(contact => contact.favorite).length}
          </span>
        </button>

        <div className="nav-section-label">{ui.groupsLabel}</div>
        {groups.map((group, index) => (
          <button
            key={group}
            className={`nav-button ${filter === group ? 'is-active' : ''}`}
            onClick={() => onFilter(group)}
            aria-current={filter === group ? 'page' : undefined}
          >
            <span
              className={`group-dot tone-${['blue', 'teal', 'violet', 'amber'][index]}`}
            />
            <span>{group}</span>
            <ChevronRight size={14} />
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <span className="local-badge">
          <ShieldCheck size={17} />
          {ui.localOnly}
        </span>
        <p>{ui.localHint}</p>
      </div>
    </aside>
  );
}
