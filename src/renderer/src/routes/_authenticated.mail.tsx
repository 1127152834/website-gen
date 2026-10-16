import { useCallback } from 'react';
import { createFileRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { MailPage } from '@/features/mail/mail-page';
import { positiveId } from '@/lib/route-params';
export const Route=createFileRoute('/_authenticated/mail')({component:MailboxRoute});
function MailboxRoute(){
  const {mailboxId,folder,uid}=useParams({strict:false});
  const navigate=useNavigate();
  const go=useCallback((path:string)=>{void navigate({to:path});},[navigate]);
  return <><MailPage mailboxId={mailboxId?positiveId(mailboxId):undefined} folder={folder} uid={uid?positiveId(uid):undefined} onNavigate={go}/><Outlet/></>;
}
