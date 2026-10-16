import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/login';
import { safeReturnTo } from '@/lib/route-guards';
import { session } from '@/lib/session';
export const Route=createFileRoute('/login')({validateSearch:(search:Record<string,unknown>):{next?:string}=>({next:safeReturnTo(search.next)}),beforeLoad:async({search})=>{const user=await session.ensure();if(user)throw redirect({to:user.mustChangePassword?'/change-password':safeReturnTo(search.next),replace:true});},component:LoginRoute});
function LoginRoute(){const navigate=Route.useNavigate();const next=safeReturnTo(Route.useSearch().next);return <LoginPage onLogin={user=>{session.set(user);void navigate({to:user.mustChangePassword?'/change-password':next,search:user.mustChangePassword?{next}:{},replace:true});}}/>;}
