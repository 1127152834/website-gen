import type { ContactDetail } from './ContactDetail';
import type { ComponentProps } from 'react';
import { ContactDetail as Detail } from './ContactDetail';
import { useDialog } from '../hooks/useDialog';
import { ui } from '../data/mockData';

interface DetailDialogProps extends Readonly<ComponentProps<typeof ContactDetail>> { readonly open: boolean; readonly onClose: () => void; }
export function DetailDialog({ open, ...props }: DetailDialogProps) {
  const dialogRef = useDialog(open);
  return <dialog ref={dialogRef} className="dialog detail-dialog" aria-label={ui.detailLabel} onCancel={props.onClose}><Detail {...props}/></dialog>;
}
