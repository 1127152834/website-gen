import type { Contact } from '../types';

interface AvatarProps { readonly contact: Pick<Contact, 'name' | 'tone'>; readonly size?: 'small' | 'large'; }
export function Avatar({ contact, size }: AvatarProps) {
  return <span aria-hidden="true" className={`avatar tone-${contact.tone} ${size ? `avatar-${size}` : ''}`}>{contact.name.slice(0, 1)}</span>;
}
