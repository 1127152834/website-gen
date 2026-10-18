import { Check, Star, Trash2, X } from 'lucide-react';
import { copy } from '../data/interfaceCopy';

interface BulkToolbarProps { readonly count:number; readonly onSelectVisible:()=>void; readonly onClear:()=>void; readonly onStar:()=>void; readonly onDelete:()=>void; readonly onClose:()=>void; }
export function BulkToolbar({count,onSelectVisible,onClear,onStar,onDelete,onClose}:BulkToolbarProps) {
  return <div className="bulk-toolbar" role="region" aria-label={copy.selectMode}><div className="bulk-count"><span><Check size={16}/></span>{copy.selected}<strong>{count}</strong></div><div className="bulk-actions"><button className="button ghost" onClick={onSelectVisible}>{copy.selectVisible}</button><button className="button ghost" disabled={!count} onClick={onStar}><Star size={16}/>{copy.bulkStar}</button><button className="button ghost danger-text" disabled={!count} onClick={onDelete}><Trash2 size={16}/>{copy.bulkDelete}</button><button className="button ghost" disabled={!count} onClick={onClear}>{copy.clearSelected}</button><button className="icon-button" onClick={onClose} aria-label={copy.exitSelection}><X size={18}/></button></div></div>;
}
