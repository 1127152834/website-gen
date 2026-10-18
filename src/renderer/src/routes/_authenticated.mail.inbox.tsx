import { useCallback } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { MailPage } from "@/features/mail/mail-page";
export const Route=createFileRoute("/_authenticated/mail/inbox")({component:InboxRoute});
function InboxRoute(){const navigate=useNavigate();const go=useCallback((path:string)=>{void navigate({to:path});},[navigate]);return <MailPage onNavigate={go}/>;}
