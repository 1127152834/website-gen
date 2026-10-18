import { Copy, Mail, Phone, Building2, Star, Pencil, Trash2, X, ShieldCheck } from 'lucide-react';
import type { Contact } from '../types';
import { ui } from '../data/mockData';
import { Avatar } from './Avatar';

interface ContactDetailProps { readonly contact: Contact; readonly onEdit: (contact: Contact) => void; readonly onDelete: (contact: Contact) => void; readonly onToggleFavorite: (id: string) => void; readonly onCopy: (value: string) => void; readonly onClose?: () => void; }
export function ContactDetail({ contact, onEdit, onDelete, onToggleFavorite, onCopy, onClose }: ContactDetailProps) {
  return <section className="contact-detail" aria-label={ui.detailLabel}><div className="detail-top"><span className="detail-kicker">{ui.detailLabel}</span><div><button className={`star-button ${contact.favorite ? 'is-favorite' : ''}`} aria-label={contact.favorite ? ui.unfavorite : ui.favorite} aria-pressed={contact.favorite} onClick={() => onToggleFavorite(contact.id)}><Star size={19} fill={contact.favorite ? 'currentColor' : 'none'}/></button>{onClose && <button className="icon-button" aria-label={ui.close} onClick={onClose}><X size={19}/></button>}</div></div>
    <div className="detail-profile"><Avatar contact={contact} size="large"/><h2>{contact.name}</h2><p className="detail-company">{contact.role || ui.noCompany}{contact.company && <><span> · </span>{contact.company}</>}</p><span className="group-badge">{contact.group}</span></div>
    <div className="detail-actions"><button className="button button-primary" onClick={() => onEdit(contact)}><Pencil size={16}/>{ui.editContact}</button><button className="button button-secondary" disabled={!contact.phone} onClick={() => onCopy(contact.phone)}><Copy size={16}/>{ui.copyPhone}</button></div>
    <dl className="detail-facts">{[{label:ui.phone,value:contact.phone,Icon:Phone},{label:ui.email,value:contact.email,Icon:Mail},{label:ui.company,value:contact.company,Icon:Building2}].map(({label,value,Icon})=><div className="fact-row" key={label}><Icon className="fact-icon" size={18}/><div className="fact-copy"><dt>{label}</dt><dd>{value || ui.unknownValue}</dd></div>{value && label!==ui.company && <button className="icon-button" aria-label={label===ui.phone ? ui.copyPhone : ui.copyEmail} onClick={() => onCopy(value)}><Copy size={15}/></button>}</div>)}</dl>
    <section className="detail-section"><h3>{ui.notes}</h3><p className="notes">{contact.notes || ui.noNotes}</p></section>
    <div className="detail-footer"><button className="button button-danger" onClick={() => onDelete(contact)}><Trash2 size={16}/>{ui.deleteContact}</button><p className="privacy-note"><ShieldCheck size={14}/>{ui.localOnly}</p></div>
  </section>;
}
