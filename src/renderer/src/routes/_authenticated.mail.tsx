import { createFileRoute } from '@tanstack/react-router';
import { MailLayout } from '@/features/mail/mail-layout';

export const Route=createFileRoute('/_authenticated/mail')({component:MailLayout});
