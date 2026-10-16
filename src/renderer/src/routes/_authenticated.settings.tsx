import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SettingsPage } from '@/features/settings/settings';
import { session } from '@/lib/session';
export const Route=createFileRoute('/_authenticated/settings')({component:()=> <SettingsPage onPasswordChanged={user=>session.set(user)}/>});
