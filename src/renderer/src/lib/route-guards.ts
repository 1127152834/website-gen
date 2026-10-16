import { redirect } from '@tanstack/react-router';
import { session } from './session';
import { safeReturnTo } from './route-params.ts';
export { positiveId, safeReturnTo, siteTabs } from './route-params.ts';
export async function requireUser(href:string){const user=await session.ensure();if(!user)throw redirect({to:'/login',search:{next:safeReturnTo(href)},replace:true});if(user.mustChangePassword)throw redirect({to:'/change-password',search:{next:safeReturnTo(href)},replace:true});return {user};}
export async function requireAdmin(){const user=await session.ensure();if(user?.role!=='admin')throw redirect({to:'/errors/403',replace:true});}
