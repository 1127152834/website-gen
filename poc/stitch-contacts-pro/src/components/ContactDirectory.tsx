import { ArrowUpRight, SearchX, Star } from 'lucide-react';
import type { Contact } from '../types';
import { groups } from '../data/mockData';
import { copy } from '../data/interfaceCopy';
import { isDue } from '../lib/book';
import { Avatar } from './Avatar';
import { ContactCard } from './ContactCard';

interface ContactDirectoryProps {
  readonly contacts: readonly Contact[]; readonly total:number; readonly layout:'grid'|'list';
  readonly selectedIds:readonly string[]; readonly selecting:boolean;
  readonly onOpen:(id:string)=>void; readonly onStar:(id:string)=>void; readonly onSelect:(id:string)=>void;
  readonly onTag:(tag:string)=>void; readonly onReset:()=>void;
}
export function ContactDirectory(props:ContactDirectoryProps) {
  return <section className="directory" aria-label={copy.directoryLabel}><div className="directory-heading"><h2 className="directory-title">{copy.sectionTitle}</h2><span className="result-count">{copy.shown} <strong>{props.contacts.length}</strong>{copy.of}{props.total} {copy.people}</span></div>
    {!props.contacts.length?<div className="empty-state"><SearchX size={36}/><h3>{copy.emptyTitle}</h3><p>{copy.emptyDescription}</p><button className="button secondary" onClick={props.onReset}>{copy.emptyReset}</button></div>:props.layout==='grid'?<div className="contact-grid">{props.contacts.map(contact=><ContactCard key={contact.id} contact={contact} selected={props.selectedIds.includes(contact.id)} selecting={props.selecting} onSelect={props.onSelect} onOpen={props.onOpen} onStar={props.onStar} onTag={props.onTag}/>)}</div>:<div className="contact-list"><div className="contact-list-head"><span>{copy.nameColumn}</span><span>{copy.companyColumn}</span><span>{copy.groupColumn}</span><span>{copy.followUpColumn}</span><span/></div>{props.contacts.map(contact=><article className={`contact-list-row ${props.selectedIds.includes(contact.id)?'is-selected':''}`} key={contact.id}><div className="row-person">{props.selecting&&<input className="selection-checkbox" type="checkbox" aria-label={`${copy.select} ${contact.name}`} checked={props.selectedIds.includes(contact.id)} onChange={()=>props.onSelect(contact.id)}/>}<button aria-label={`${copy.openContact} ${contact.name}`} onClick={()=>props.onOpen(contact.id)}><Avatar contact={contact}/><span><strong>{contact.name}</strong><small>{contact.english}</small></span></button></div><div className="row-company"><strong>{contact.company||copy.noCompany}</strong><small>{contact.role||copy.noRole}</small></div><span className={`tag row-group color-${contact.color}`}>{groups.find(g=>g.id===contact.groupId)?.label}</span><span className={`row-followup ${isDue(contact)?'is-due':''}`}>{contact.followUp||'—'}</span><div className="row-actions"><button className={`star-button ${contact.starred?'is-starred':''}`} aria-label={`${contact.starred?copy.unstar:copy.star} ${contact.name}`} aria-pressed={contact.starred} onClick={()=>props.onStar(contact.id)}><Star size={17} fill={contact.starred?'currentColor':'none'}/></button><button className="icon-button" aria-label={`${copy.openContact} ${contact.name}`} onClick={()=>props.onOpen(contact.id)}><ArrowUpRight size={18}/></button></div></article>)}</div>}
  </section>;
}
