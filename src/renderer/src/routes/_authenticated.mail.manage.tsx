import { createFileRoute } from "@tanstack/react-router";
import { MailManagementPage } from "@/features/mail/mail-management-page";
export const Route=createFileRoute("/_authenticated/mail/manage")({component:MailManagementPage});
