import {readFile,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';

// Launcher-owned profileContext is authoritative. The CLI does not promise
// DSH_PROFILE or DSH_PROFILE_DIR, and process.cwd() is a workspace, not storage.
export function storageLocation(config={},profile,env=process.env,userHome=homedir()) {
  const explicit=config.stateFile!==undefined&&config.stateFile!==null;
  const home=env.DSH_HOME||join(userHome,'.dsh');
  const legacyDir=env.DSH_PROFILE_DIR||join(home,'profiles',env.DSH_PROFILE||'default');
  const legacyFile=resolve(join(legacyDir,'retry-manager','state.json'));
  const stateFile=resolve(config.stateFile??join(profile?.dir||legacyDir,'retry-manager','state.json'));
  return {stateFile,legacyStateFile:explicit||stateFile===legacyFile?undefined:legacyFile,
    profile:profile?.name||env.DSH_PROFILE||'default',scope:explicit?'custom':profile?.dir?'profile':'environment'};
}
export async function withStorageLock(file,operation) {
  await mkdir(dirname(file),{recursive:true});
  const release=await lockfile.lock(file,{realpath:false,stale:5000,update:1000,
    retries:{retries:65,minTimeout:30,maxTimeout:100,factor:1.2,randomize:false}});
  try {return await operation();} finally {await release();}
}
export async function readStoreFile(file,schema,label,empty,allowMissing) {
  try {return {state:schema.parse(JSON.parse(await readFile(file,'utf8'))),persisted:true};}
  catch(error) {
    if(error.code==='ENOENT'&&allowMissing)return {state:empty(),persisted:false};
    throw new Error(label+'读取失败，请检查配置文件和存储权限；已有设置未被重置',{cause:error});
  }
}
export async function initializeStore(file,legacyFile,schema,label,empty) {
  return withStorageLock(file,async()=>{
    const current=await readStoreFile(file,schema,label,empty,true);
    if(current.persisted||!legacyFile||resolve(file)===resolve(legacyFile))return current;
    let raw;
    try {raw=await readFile(legacyFile,'utf8');}
    catch(error){if(error.code==='ENOENT')return current;throw new Error(label+'迁移读取失败；原文件未改变',{cause:error});}
    let parsed;
    try {parsed=schema.parse(JSON.parse(raw));}
    catch(error){throw new Error(label+'读取失败；旧文件无效，未覆盖目标配置',{cause:error});}
    await writeFileAtomic(file,raw,{mode:0o600});
    return {state:parsed,persisted:true};
  });
}
