import { useCallback } from 'react';
import { createFileRoute, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { MailPage } from '@/features/mail/mail-page';
import { positiveId } from '@/lib/route-guards';
import type { CaseSourceReaderRef } from '../../../shared/mail-triage-types.ts';

export const Route=createFileRoute('/_authenticated/mail/$mailboxId')({beforeLoad:({params})=>{positiveId(params.mailboxId);},component:MailboxRoute});

function MailboxRoute(){
  const {mailboxId,folder,uid}=useParams({strict:false});
  const search=useSearch({strict:false}) as {caseId?:string;sourceId?:string;sourceVersion?:number;uidValidity?:string;replyTaskIds?:string};
  const navigate=useNavigate();
  const go=useCallback((path:string)=>{void navigate({to:path});},[navigate]);
  const sourceRef:CaseSourceReaderRef|undefined=uid&&folder&&search.caseId&&search.sourceId&&search.sourceVersion&&search.uidValidity?{caseId:search.caseId,sourceId:search.sourceId,sourceVersion:search.sourceVersion,uidValidity:search.uidValidity,mailboxId:positiveId(mailboxId??''),folder,uid:positiveId(uid)}:undefined;
  const selectedTaskIds=search.replyTaskIds?.split(",").filter(Boolean)??[];
  const composeHandoff=sourceRef&&selectedTaskIds.length?{caseId:sourceRef.caseId,selectedTaskIds,readerRef:sourceRef}:undefined;
  return <><MailPage mailboxId={positiveId(mailboxId ?? '')} folder={folder} uid={uid?positiveId(uid):undefined} sourceRef={sourceRef} composeHandoff={composeHandoff} onNavigate={go}/><Outlet/></>;
}
