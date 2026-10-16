import { createFileRoute, Outlet } from '@tanstack/react-router';

export const Route=createFileRoute('/_authenticated/mail/$mailboxId/$folder')({component:Outlet});
