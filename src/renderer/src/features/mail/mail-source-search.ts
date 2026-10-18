export type MailSourceSearch={caseId?:string;sourceId?:string;sourceVersion?:number;uidValidity?:string;replyTaskIds?:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 来源绑定必须全有或全无；部分参数绝不降级为旧三元组 reader。 */
export function parseMailSourceSearch(search:Record<string,unknown>):MailSourceSearch{
  const keys=['caseId','sourceId','sourceVersion','uidValidity'] as const,count=keys.filter(key=>search[key]!==undefined).length;
  if(count===0){if(search.replyTaskIds!==undefined)throw new Error('回复义务缺少完整来源绑定');return{};}
  if(count!==keys.length||typeof search.caseId!=="string"||!uuid.test(search.caseId)||typeof search.sourceId!=="string"||!uuid.test(search.sourceId)||!Number.isSafeInteger(Number(search.sourceVersion))||Number(search.sourceVersion)<=0||typeof search.uidValidity!=="string"||!search.uidValidity.trim()||/[\0\r\n]/.test(search.uidValidity))throw new Error('来源绑定参数不完整或无效');
  let replyTaskIds: string|undefined;
  if(search.replyTaskIds!==undefined){if(typeof search.replyTaskIds!=="string")throw new Error('回复义务参数无效');const ids=search.replyTaskIds.split(',');if(ids.length<1||ids.length>20||ids.some(id=>!uuid.test(id)))throw new Error('回复义务参数无效');replyTaskIds=ids.join(',');}
  return{caseId:search.caseId,sourceId:search.sourceId,sourceVersion:Number(search.sourceVersion),uidValidity:search.uidValidity,...(replyTaskIds?{replyTaskIds}:{})};
}
