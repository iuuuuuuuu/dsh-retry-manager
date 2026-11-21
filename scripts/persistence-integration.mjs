import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,symlink,unlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
if(!process.env.DSH_DIST)throw Error('DSH_DIST must identify a real DSH installation.');
const requireDsh=createRequire(resolve(process.env.DSH_DIST)),cli=requireDsh.resolve('@deepseek-ai/dsh/lib/bin.js');
const {resolveProfileDir}=await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href);
const pluginRoot=process.env.RETRY_PLUGIN_ROOT||fileURLToPath(new URL('../',import.meta.url));
const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-persistence-')),home=join(dir,'home'),handles=[],links=[],checks=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),safe=text=>String(text).replace(/([?&]token=)[^\s"']+/g,'$1[redacted]');
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function prepare(name,patch=''){
 const profile=resolveProfileDir(name,home);await mkdir(join(profile,'node_modules'),{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,type:'module',dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-retry-manager']}}},null,2));
 const link=join(profile,'node_modules/dsh-retry-manager');await symlink(pluginRoot,link,'junction');links.push(link);
 await writeFile(join(profile,'cordis.patch.yml'),'- id: session-title-llm\n  disabled: true\n- id: llm-deepseek\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n'+patch);
 return profile;
}
async function start(name,cwd=dir,extra={}){
 const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',HOME:home,USERPROFILE:home,NO_COLOR:'1'};
 delete env.DSH_PROFILE;delete env.DSH_PROFILE_DIR;Object.assign(env,extra);
 const child=spawn(process.execPath,[cli,'--profile',name,'--no-open','--port','0'],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const handle={child,async stop(){if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(10000)]);assert.ok(child.exitCode!==null||child.signalCode!==null,'owned DSH process must stop');}}};handles.push(handle);
 let url;for(let i=0;i<300;i++){const line=output.split('dsh web: ').at(-1)?.split(String.fromCharCode(10))[0]?.trim();if(line?.startsWith('http://127.0.0.1:')&&line.includes('?token=')){url=line;break;}if(child.exitCode!==null)throw Error('Actual DSH startup failed: '+safe(output));await sleep(100);}assert.ok(url,'real host must start');
 const origin=new URL(url).origin,login=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});assert.equal(login.status,303);const headers={cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),'content-type':'application/json'};
 handle.request=async(body,q='')=>{const r=await fetch(origin+'/api/dsh-retry-manager'+q,{headers,...body?{method:'POST',body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(20000)});return{status:r.status,value:await r.json()};};
 handle.get=async()=>{const r=await handle.request();assert.equal(r.status,200);return r.value;};
 handle.save=async body=>{const before=await handle.get(),r=await handle.request({...body,revision:before.revision});assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
 return handle;
}
try{
 const alphaDir=await prepare('persist-alpha'),betaDir=await prepare('persist-beta');await mkdir(join(dir,'other-cwd'));
 let alpha=await start('persist-alpha');assert.equal((await alpha.get()).defaultMaxRetries,null);await alpha.save({op:'default',maxRetries:17,retryIntervalMs:1700});await alpha.save({op:'model',provider:'fixture',model:'alpha-model',maxRetries:73});const alphaSaved=await alpha.get();await alpha.stop();
 let beta=await start('persist-beta',join(dir,'other-cwd'));const betaInitial=await beta.get();await beta.save({op:'default',maxRetries:2,retryIntervalMs:2200});await beta.save({op:'model',provider:'fixture',model:'beta-model',maxRetries:9});const betaSaved=await beta.get();await beta.stop();
 alpha=await start('persist-alpha',join(dir,'other-cwd'));const alphaRestarted=await alpha.get();
 assert.equal(alphaRestarted.defaultMaxRetries,17,'ordinary --profile alpha restart must not load beta or fallback-default state');assert.equal(alphaRestarted.retryIntervalMs,1700);assert.deepEqual(alphaRestarted.models,alphaSaved.models);assert.equal(alphaRestarted.revision,alphaSaved.revision);assert.equal(betaInitial.defaultMaxRetries,null,'a new independent profile must start independently');await alpha.stop();
 assert.equal(JSON.parse(await readFile(join(alphaDir,'retry-manager/state.json'),'utf8')).defaultMaxRetries,17);assert.equal(JSON.parse(await readFile(join(betaDir,'retry-manager/state.json'),'utf8')).defaultMaxRetries,2);pass('actual CLI profiles remain independent across full process stop/start without synthetic profile environment variables');
 const misleading=resolveProfileDir('misleading-env',home);alpha=await start('persist-alpha',dir,{DSH_PROFILE:'misleading-env',DSH_PROFILE_DIR:misleading});assert.equal((await alpha.get()).defaultMaxRetries,17);await alpha.stop();pass('official host profileContext wins over misleading launcher environment variables and working directories');
 beta=await start('persist-beta');assert.deepEqual(await beta.get(),betaSaved);await beta.stop();pass('restarting a second profile cannot overwrite the first profile or lose its model override');

 const {errorSignature,createInbox,errorFamilyKey,groupId}=await import(pathToFileURL(join(pluginRoot,'lib/errors.js')).href);
 const legacy=join(resolveProfileDir('default',home),'retry-manager');await mkdir(legacy,{recursive:true});
 const error=errorSignature({code:'SERVER',status:502,message:'502 legacy interruption'}),entry={id:'legacy-session:1',groupId:groupId('fixture','legacy-model',error.fingerprint),sessionId:'legacy-session',provider:'fixture',model:'legacy-model',turn:1,step:1,seq:1,time:Date.now(),error,boundary:true,outcome:'terminal'};
 const migrationState={version:1,revision:8,defaultMaxRetries:61,retryIntervalMs:2300,models:{'["fixture","legacy-model"]':72},sessions:{'legacy-session':0},errorRules:[{id:randomUUID(),scope:'model',target:'["fixture","legacy-model"]',action:'keep',error,confirmedRisk:false,createdAt:1,updatedAt:1}]};
 const raw=JSON.stringify(migrationState,null,2)+'\n';await writeFile(join(legacy,'state.json'),raw);const legacyInbox=await createInbox(join(legacy,'errors.json'));await legacyInbox.record(entry);await legacyInbox.setIgnored(0,errorFamilyKey('fixture','legacy-model',error),entry);await legacyInbox.drain();
 const migratedDir=await prepare('persist-migrated');let migrated=await start('persist-migrated');assert.equal((await migrated.get()).defaultMaxRetries,61);assert.equal((await migrated.get()).models[0].maxRetries,72);let view=(await migrated.request(undefined,'?errors=1')).value;assert.equal(view.rules.length,1);assert.equal(view.views.ignored.length,1);assert.equal(view.views.configured.length,1);assert.equal(view.visibilityRevision,1);assert.equal(await readFile(join(migratedDir,'retry-manager/state.json'),'utf8'),raw);assert.equal(await readFile(join(legacy,'state.json'),'utf8'),raw);
 await migrated.save({op:'default',maxRetries:62,retryIntervalMs:2400});await migrated.stop();await writeFile(join(legacy,'state.json'),JSON.stringify({...migrationState,revision:999,defaultMaxRetries:99}));migrated=await start('persist-migrated');assert.equal((await migrated.get()).defaultMaxRetries,62);assert.equal((await migrated.get()).retryIntervalMs,2400);view=(await migrated.request(undefined,'?errors=1')).value;assert.equal(view.rules.length,1);assert.equal(view.views.ignored.length,1);await migrated.stop();pass('one-time legacy migration retains exact rules and ignored errors, while existing canonical data always wins on later restarts');
 const pinned=join(dir,'pinned/state.json');await mkdir(join(dir,'pinned'));await writeFile(pinned,JSON.stringify({...migrationState,revision:2,defaultMaxRetries:31}));await prepare('persist-explicit','- id: dsh-retry-manager\n  config:\n    stateFile: '+JSON.stringify(pinned)+'\n');const explicit=await start('persist-explicit');assert.equal((await explicit.get()).defaultMaxRetries,31);await explicit.save({op:'default',maxRetries:32});await explicit.stop();const explicitRestarted=await start('persist-explicit',join(dir,'other-cwd'));assert.equal((await explicitRestarted.get()).defaultMaxRetries,32);await explicitRestarted.stop();pass('explicit custom stateFile remains authoritative and persistent across cwd changes');
 if(process.env.DSH_PERSISTENCE_RECEIPT)await writeFile(process.env.DSH_PERSISTENCE_RECEIPT,JSON.stringify({checks,checkCount:checks.length,realDSHCLI:true,realProcessRestarts:true,noProfileEnvironmentShortcut:true,noPaidModelCalls:true},null,2)+'\n');
 console.log('ALL REAL PERSISTENCE CHECKS PASSED '+checks.length);
}catch(error){console.error(safe(error?.stack??error));process.exitCode=1;}finally{for(const h of handles)await h.stop();for(const link of links)await unlink(link);await rm(dir,{recursive:true,force:true});}
