import { ArrowUpRight, CalendarDays, Mail, Phone, Star } from 'lucide-react';
import type { Contact } from '../types';
import { groups } from '../data/mockData';
import { copy } from '../data/interfaceCopy';
import { isDue } from '../lib/book';
import { Avatar } from './Avatar';

interface ContactCardProps {
  readonly contact: Contact; readonly selected:boolean; readonly selecting:boolean;
  readonly onSelect:(id:string)=>void; readonly onOpen:(id:string)=>void;
  readonly onStar:(id:string)=>void; readonly onTag:(tag:string)=>void;
}
export function ContactCard({contact,selected,selecting,onSelect,onOpen,onStar,onTag}:ContactCardProps) {
  const group=groups.find(g=>g.id===contact.groupId)!;
  const due=isDue(contact);
  return <article className={`contact-card ${selected?'is-selected':''} ${due?'is-due':''}`}>
    <div className="card-top"><button className="card-identity" aria-label={`${copy.openContact} ${contact.name}`} onClick={()=>onOpen(contact.id)}><Avatar contact={contact} size="lg"/><span className="card-heading"><strong className="card-name">{contact.name}</strong><span className="card-english">{contact.english}</span><span className="card-role">{contact.role||copy.noRole}</span></span></button>{selecting?<input className="selection-checkbox" type="checkbox" checked={selected} aria-label={`${copy.select} ${contact.name}`} onChange={()=>onSelect(contact.id)}/>:<button className={`star-button ${contact.starred?'is-starred':''}`} onClick={()=>onStar(contact.id)} aria-label={`${contact.starred?copy.unstar:copy.star} ${contact.name}`} aria-pressed={contact.starred}><Star size={18} fill={contact.starred?'currentColor':'none'}/></button>}</div>
    <p className="card-company">{contact.company||copy.noCompany}</p>
    <div className="card-tags"><span className={`tag group-tag color-${contact.color}`}>{group.label}</span>{contact.tags.slice(0,2).map(tag=><button className="tag" key={tag} onClick={()=>onTag(tag)}>{tag}</button>)}{due && <span className="due-tag"><span/>{copy.followUp}</span>}</div>
    <div className="card-details"><span className="card-detail"><Phone size={14}/><span>{contact.phone||copy.noPhone}</span></span><span className="card-detail"><Mail size={14}/><span>{contact.email||copy.noEmail}</span></span></div>
    <div className="card-footer"><span className={`contact-cadence ${due?'is-due':''}`}><span/>{contact.followUp?<><CalendarDays size={12}/>{contact.followUp}</>:contact.lastContacted?`${copy.lastContact} ${contact.lastContacted}`:copy.never}</span><button className="card-open" aria-label={`${copy.openContact} ${contact.name}`} onClick={()=>onOpen(contact.id)}><ArrowUpRight size={18}/></button></div>
  </article>;
}

