import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {storageLocation} from '../src/storage.js';
import {createStore} from '../src/state.js';
import {createInbox,errorSignature,errorFamilyKey,groupId} from '../src/errors.js';
const root=()=>mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-storage-'));
const oldState={version:1,revision:7,defaultMaxRetries:61,retryIntervalMs:2300,models:{'["p","m"]':72},sessions:{retained:0},errorRules:[]};
test('official profile context and explicit stateFile outrank environment and cwd defaults',async()=>{
 const dir=await root();try{const actual={name:'alpha',dir:join(dir,'actual-alpha')},env={DSH_HOME:dir,DSH_PROFILE:'wrong',DSH_PROFILE_DIR:join(dir,'wrong')};
 const location=storageLocation({},actual,env,dir);assert.equal(location.stateFile,resolve(actual.dir,'retry-manager/state.json'));assert.equal(location.scope,'profile');assert.equal(location.profile,'alpha');assert.equal(location.legacyStateFile,resolve(env.DSH_PROFILE_DIR,'retry-manager/state.json'));
 const pinned=storageLocation({stateFile:join(dir,'pinned.json')},actual,env,dir);assert.equal(pinned.stateFile,resolve(dir,'pinned.json'));assert.equal(pinned.scope,'custom');assert.equal(pinned.legacyStateFile,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy migration preserves bytes, never overwrites existing canonical data, and fails closed on corruption',async()=>{
 const dir=await root();try{const legacy=join(dir,'legacy/state.json'),file=join(dir,'actual/state.json');await mkdir(join(dir,'legacy'));const raw=JSON.stringify(oldState,null,2)+'\n';await writeFile(legacy,raw);
 let store=await createStore(file,{legacyFile:legacy});assert.equal(await readFile(file,'utf8'),raw);assert.equal(await readFile(legacy,'utf8'),raw);assert.deepEqual(store.snapshot(),oldState);
 await store.update(7,s=>s.defaultMaxRetries=62);await writeFile(legacy,JSON.stringify({...oldState,revision:999,defaultMaxRetries:99}));store=await createStore(file,{legacyFile:legacy});assert.equal(store.snapshot().defaultMaxRetries,62);assert.equal(store.snapshot().revision,8);
 await writeFile(file,'broken');await assert.rejects(createStore(file,{legacyFile:legacy}),/读取失败/);assert.equal(await readFile(file,'utf8'),'broken');
 const absent=join(dir,'other/state.json');await writeFile(legacy,'bad-legacy');await assert.rejects(createStore(absent,{legacyFile:legacy}),/读取失败/);await assert.rejects(readFile(absent),e=>e.code==='ENOENT');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('stale store instances reload disk revisions instead of resetting newer global/model settings',async()=>{
 const dir=await root();try{const file=join(dir,'state.json'),a=await createStore(file),b=await createStore(file);
 await a.update(0,s=>s.defaultMaxRetries=17);await assert.rejects(b.update(0,s=>s.models['["p","m"]']=73),e=>e.status===409);assert.equal(b.snapshot().defaultMaxRetries,17);
 await b.update(1,s=>s.models['["p","m"]']=73);await a.refresh();assert.equal(a.snapshot().defaultMaxRetries,17);assert.equal(a.snapshot().models['["p","m"]'],73);
 await rm(file);await assert.rejects(a.update(2,s=>s.defaultMaxRetries=0),/读取失败/);await assert.rejects(a.refresh(),/读取失败/);await assert.rejects(readFile(file),e=>e.code==='ENOENT');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('independent inbox instances preserve ignores while collecting, restoring and reloading',async()=>{
 const dir=await root();try{const file=join(dir,'errors.json'),a=await createInbox(file),b=await createInbox(file),error=errorSignature({code:'SERVER',status:502,message:'502 interrupted'}),key=errorFamilyKey('p','m',error);
 const make=seq=>({id:'s:'+seq,groupId:groupId('p','m',error.fingerprint),sessionId:'s',provider:'p',model:'m',turn:1,step:1,seq,time:Date.now()+seq,error,boundary:true,outcome:'terminal'});
 await a.record(make(1));await a.setIgnored(0,key,make(1));await b.record(make(2));assert.equal(b.snapshot().ignored.length,1);assert.equal(b.snapshot().visibilityRevision,1);assert.equal(b.snapshot().entries.length,2);
 await assert.rejects(b.setIgnored(0,key,null),e=>e.status===409);await b.setIgnored(1,key,null);await a.record(make(3));assert.equal(a.snapshot().ignored.length,0);assert.equal(a.snapshot().entries.length,3);assert.equal(a.snapshot().visibilityRevision,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('two real Node writers cannot both commit the same on-disk revision',async()=>{
 const dir=await root(),children=[];try{const file=join(dir,'state.json'),moduleUrl=new URL('../src/state.js',import.meta.url).href;
 const code="const {createStore}=await import(process.argv[1]);const store=await createStore(process.argv[2]);process.on('message',async message=>{if(message==='stop'){process.disconnect();return;}try{await store.update(message.revision,s=>s.models[message.key]=message.value);process.send({kind:'saved',revision:store.snapshot().revision});}catch(error){if(error.status!==409){console.error(error);process.exitCode=1;process.disconnect();return;}process.send({kind:'conflict',revision:store.snapshot().revision});}});process.send({kind:'ready'});";
 function child(){const c=spawn(process.execPath,['--input-type=module','-e',code,moduleUrl,file],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.push(c);let err='';c.stderr.on('data',b=>err+=b);return{c,error:()=>err};}
 const a=child(),b=child();const first=await Promise.all([once(a.c,'message'),once(b.c,'message')]);assert.ok(first.every(([m])=>m.kind==='ready'));
 const pa=once(a.c,'message'),pb=once(b.c,'message');a.c.send({revision:0,key:'alpha',value:17});b.c.send({revision:0,key:'beta',value:73});const results=(await Promise.all([pa,pb])).map(([m])=>m);assert.equal(results.filter(m=>m.kind==='saved').length,1);assert.equal(results.filter(m=>m.kind==='conflict').length,1);
 const loser=results[0].kind==='conflict'?a:b;const next=once(loser.c,'message');loser.c.send({revision:1,key:loser===a?'alpha':'beta',value:loser===a?17:73});assert.equal((await next)[0].kind,'saved');assert.deepEqual((await createStore(file)).snapshot().models,{alpha:17,beta:73});
 for(const x of [a,b]){const exited=once(x.c,'exit');x.c.send('stop');assert.equal((await exited)[0],0);assert.equal(x.error(),'');}
 }finally{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill();await rm(dir,{recursive:true,force:true});}
});
