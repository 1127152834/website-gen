import { createFileRoute } from '@tanstack/react-router';
import { MailBoardPage } from '@/features/mail/mail-board-page';

export const Route=createFileRoute('/_authenticated/mail/')({component:MailBoardPage});
