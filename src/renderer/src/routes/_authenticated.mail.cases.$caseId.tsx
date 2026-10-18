import { createFileRoute } from "@tanstack/react-router";
import { MailBoardPage } from "@/features/mail/mail-board-page";

export const Route=createFileRoute("/_authenticated/mail/cases/$caseId")({component:MailCaseRoute});
function MailCaseRoute(){const {caseId}=Route.useParams();return <MailBoardPage caseId={caseId}/>;}
