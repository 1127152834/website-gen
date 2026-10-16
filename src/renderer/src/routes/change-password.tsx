import { createFileRoute, redirect } from '@tanstack/react-router';
import { ForcedChangePasswordPage, ChangePasswordForm } from '@/features/auth/change-password';
import { session } from '@/lib/session';
import { safeReturnTo } from '@/lib/route-guards';
import { useSession } from '@/hooks/use-session';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
export const Route=createFileRoute('/change-password')({validateSearch:(search:Record<string,unknown>):{next?:string}=>({next:safeReturnTo(search.next)}),beforeLoad:async()=>{if(!await session.ensure())throw redirect({to:'/login',replace:true});},component:PasswordRoute});
function PasswordRoute(){const {user}=useSession();const navigate=Route.useNavigate();const next=safeReturnTo(Route.useSearch().next);if(!user)return null;const changed=(user:NonNullable<ReturnType<typeof session.snapshot>['user']>)=>{session.set(user);void navigate({to:next,search:{},replace:true});};return user.mustChangePassword?<ForcedChangePasswordPage username={user.username} onChanged={changed}/>:<main className="flex min-h-svh items-center justify-center p-4"><Card className="w-full max-w-md"><CardHeader><CardTitle>修改密码</CardTitle><CardDescription>修改后，当前设备以外的登录会话都会退出。</CardDescription></CardHeader><CardContent><ChangePasswordForm onChanged={changed} onCancel={()=>void navigate({to:next,search:{}})}/></CardContent></Card></main>;}
