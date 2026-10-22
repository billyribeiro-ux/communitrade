import {readdir,readFile,realpath,stat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';

/** Read installed package roots, never execute package code or inspect env files. */
export async function installedInventory(modulesRoot){
  const root=await realpath(modulesRoot),seen=new Set(),packages=[];
  const label=value=>typeof value==='string'?value:Array.isArray(value)?value.map(label).filter(Boolean).join(' OR '):value?.type??null;
  async function packageAt(path){
    let actual;try{actual=await realpath(path);}catch{return;}
    if(seen.has(actual)||relative(root,actual).startsWith('..'))return;
    seen.add(actual);
    let data;try{data=JSON.parse(await readFile(join(actual,'package.json'),'utf8'));}catch{return;}
    if(!data.name||!data.version)return;
    const notices=[];
    for(const entry of await readdir(actual,{withFileTypes:true})){
      if(!entry.isFile()||!/(?:^licen[cs]e|^notice|^copying|^copyright|thirdpartynotices)/i.test(entry.name))continue;
      const file=join(actual,entry.name);if((await stat(file)).size>4*1024*1024)throw new Error('License file exceeds bounded inventory size.');
      notices.push({name:entry.name,base64:(await readFile(file)).toString('base64')});
    }
    packages.push({name:data.name,version:data.version,license:label(data.license??data.licenses),workspace:data.name.startsWith('@trading/'),notices});
    await walk(join(actual,'node_modules'));
  }
  async function walk(path){
    for(const entry of await readdir(path,{withFileTypes:true}).catch(()=>[])){
      if(entry.name==='.pnpm'){
        for(const version of await readdir(join(path,entry.name),{withFileTypes:true}))if(version.isDirectory())await walk(join(path,entry.name,version.name,'node_modules'));
      }else if(entry.name.startsWith('@')){
        for(const scoped of await readdir(join(path,entry.name),{withFileTypes:true}).catch(()=>[]))await packageAt(join(path,entry.name,scoped.name));
      }else if(!entry.name.startsWith('.')&&(entry.isDirectory()||entry.isSymbolicLink()))await packageAt(join(path,entry.name));
    }
  }
  await walk(root);
  return [...new Map(packages.map(p=>[`${p.name}@${p.version}`,p])).values()].sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename)console.log(JSON.stringify(await installedInventory(process.argv[2]??'node_modules')));
