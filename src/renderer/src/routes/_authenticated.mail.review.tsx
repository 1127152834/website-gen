import { createFileRoute } from "@tanstack/react-router";
import { MailReviewPage } from "@/features/mail/mail-review-page";
export const Route=createFileRoute("/_authenticated/mail/review")({component:()=> <MailReviewPage/>});
