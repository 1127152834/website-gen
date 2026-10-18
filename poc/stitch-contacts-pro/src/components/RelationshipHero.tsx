import { ArrowUpRight, Clock3, Sparkle } from 'lucide-react';
import type { Contact } from '../types';
import { copy } from '../data/interfaceCopy';
import { isDue } from '../lib/book';
import { Avatar } from './Avatar';

interface RelationshipHeroProps {
  readonly contacts: readonly Contact[];
  readonly counts: { all: number; starred: number; due: number };
  readonly onDue: () => void;
  readonly onOpen: (id:string) => void;
}
export function RelationshipHero({ contacts, counts, onDue, onOpen }: RelationshipHeroProps) {
  const reminder = contacts.find(contact=>isDue(contact));
  return <section className="relationship-hero" aria-label={copy.heroDescription}>
    <div className="hero-main"><div className="hero-copy"><p className="hero-eyebrow"><span/>{copy.heroLabel}</p><h2 className="hero-title">{copy.heroTitle1}<br/>{copy.heroTitle2}</h2><p className="hero-description">{copy.heroDescription}</p></div><div className="hero-decoration" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><Sparkle className="hero-spark" size={26}/><div className="avatar-stack">{contacts.filter(c=>c.starred).slice(0,4).map(c=><Avatar key={c.id} contact={c} size="lg"/>)}</div><span className="hero-note">{copy.localSubtitle}</span></div><div className="hero-bottom"><div className="hero-stats">{[{value:counts.all,label:copy.statPeople},{value:counts.starred,label:copy.statStars},{value:counts.due,label:copy.statDue}].map(stat=><div className="hero-stat" key={stat.label}><strong>{String(stat.value).padStart(2,'0')}</strong><span className="hero-stat-label">{stat.label}</span></div>)}</div></div></div>
    <div className="reminder-card"><div className="reminder-eyebrow"><Clock3 size={15}/>{copy.reminderEyebrow}</div><h2 className="reminder-title">{reminder?copy.reminderTitle:copy.reminderEmpty}</h2>{reminder?<button className="reminder-contact" onClick={()=>onOpen(reminder.id)}><Avatar contact={reminder}/><span className="reminder-copy"><strong>{reminder.name}<span>{copy.followUp}</span></strong><small>{reminder.role} · {reminder.company}</small></span><ArrowUpRight size={18}/></button>:<p className="hero-description">{copy.reminderDescription}</p>}<button className="reminder-footer" onClick={onDue}><span>{copy.reminderAction}</span><ArrowUpRight size={18}/></button></div>
  </section>;
}
