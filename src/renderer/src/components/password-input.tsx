// Adapted from shadcn-admin (MIT), see renderer/THIRD_PARTY_NOTICES.
import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './ui/input';
import { Button } from './ui/button';
export function PasswordInput({className,...props}:Omit<ComponentProps<typeof Input>,'type'>){const [visible,setVisible]=useState(false);return <div className="relative"><Input {...props} type={visible?'text':'password'} className={`pr-10 ${className??''}`} /><Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1/2 -translate-y-1/2" disabled={props.disabled} aria-label={visible?'隐藏密码':'显示密码'} aria-pressed={visible} onClick={()=>setVisible(v=>!v)}>{visible?<EyeOff aria-hidden/>:<Eye aria-hidden/>}</Button></div>;}
