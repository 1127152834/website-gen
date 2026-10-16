import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
const base='src/renderer/.migration/baseline/src/renderer/src';
const current='src/renderer/src';
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(dir,entry.name)):[path.join(dir,entry.name)]);}
function inventory(dir,backup=false){
  const methods=new Map();
  for(const file of files(dir).filter(file=>/\.tsx?(?:\.bak)?$/.test(file)&&!file.includes('.test.')&&!file.endsWith('routeTree.gen.ts'))){
    const text=fs.readFileSync(file,'utf8');
    const source=parse(text,{sourceType:'module',plugins:['typescript','jsx']});
    function visit(node){
      if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&['call','useRpcData'].includes(node.callee.name)&&node.arguments[0]?.type==='StringLiteral'){
        const method=node.arguments[0].value;
        const payload=node.arguments[1];
        const shape=payload?.type==='ObjectExpression'?payload.properties.map(property=>property.key?.name??property.key?.value??'...').sort():payload?text.slice(payload.start,payload.end):'undefined';
        const entries=methods.get(method)??[];entries.push({file:path.relative(dir,file).replace(/\.bak$/,''),shape});methods.set(method,entries);
      }
      for(const value of Object.values(node)){
        if(Array.isArray(value)){for(const item of value)if(item&&typeof item.type==='string')visit(item);}
        else if(value&&typeof value.type==='string')visit(value);
      }
    }visit(source);
  }
  return Object.fromEntries([...methods].sort(([a],[b])=>a.localeCompare(b)));
}
const old=inventory(base,true),next=inventory(current);
const missing=Object.keys(old).filter(method=>!(method in next));
const added=Object.keys(next).filter(method=>!(method in old));
const result={baselineMethodCount:Object.keys(old).length,currentMethodCount:Object.keys(next).length,missing,added,baseline:old,current:next};
fs.writeFileSync('src/renderer/.migration/rpc-inventory.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({baselineMethodCount:result.baselineMethodCount,currentMethodCount:result.currentMethodCount,missing,added}));
if(missing.length)process.exitCode=1;
