// Adapted from shadcn-admin, Sat Naing, MIT (renderer/THIRD_PARTY_NOTICES).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
type Theme='light'|'dark'|'system';
const ThemeContext=createContext<{theme:Theme;setTheme:(theme:Theme)=>void}>({theme:'system',setTheme:()=>{}});
function storedTheme():Theme{try{const value=localStorage.getItem('console-theme');return value==='light'||value==='dark'?value:'system';}catch{return 'system';}}
export function ThemeProvider({children}:{children:ReactNode}){
  const [theme,setValue]=useState<Theme>(storedTheme);
  useEffect(()=>{const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{const dark=theme==='dark'||(theme==='system'&&media.matches);document.documentElement.classList.toggle('dark',dark);document.documentElement.style.colorScheme=dark?'dark':'light';};apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);},[theme]);
  useEffect(()=>{const sync=(event:StorageEvent)=>{if(event.key==='console-theme')setValue(storedTheme());};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);},[]);
  const setTheme=(next:Theme)=>{setValue(next);try{localStorage.setItem('console-theme',next);}catch{/* session-only theme */}};
  return <ThemeContext value={{theme,setTheme}}>{children}</ThemeContext>;
}
export const useTheme=()=>useContext(ThemeContext);
