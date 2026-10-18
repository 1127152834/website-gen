import type { ComponentProps, JSX } from 'react';
import { ui } from '../data/mockData';
import { useDialog } from '../hooks/useDialog';
import { ContactDetail } from './ContactDetail';

interface DetailDialogProps extends Readonly<ComponentProps<typeof ContactDetail>> {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function DetailDialog({ open, ...props }: DetailDialogProps): JSX.Element {
  const dialogRef = useDialog(open);

  return (
    <dialog
      ref={dialogRef}
      className="dialog detail-dialog"
      aria-label={ui.detailLabel}
      onCancel={props.onClose}
    >
      <ContactDetail {...props} />
    </dialog>
  );
}
