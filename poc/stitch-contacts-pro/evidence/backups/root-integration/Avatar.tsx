import type { Contact, ContactDraft } from '../types';
import { demoPortraits } from '../data/portraits';

interface AvatarProps {
  readonly contact: Contact | ContactDraft;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
  readonly className?: string;
}
export function Avatar({ contact, size = 'md', className = '' }: AvatarProps) {
  const source = contact.avatar || ('id' in contact ? demoPortraits[contact.id] : '');
  return (
    <span className={`avatar avatar-${size} color-${contact.color} ${className}`} aria-hidden="true">
      {source ? <img className="avatar-image" src={source} alt="" loading="lazy" draggable={false}/> : <span className="avatar-fallback">{contact.name.slice(0, 1) || '+'}</span>}
    </span>
  );
}
