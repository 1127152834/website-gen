import { createFileRoute } from "@tanstack/react-router";
import { MailTriageSettingsPage } from "@/features/mail/mail-triage-settings-page";
export const Route=createFileRoute("/_authenticated/mail/settings")({component:MailTriageSettingsPage});
