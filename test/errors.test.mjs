import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {errorSignature,createInbox,groupId,groupErrors,groupErrorFamilies} from '../src/errors.js';
import {decideFailure,executionPolicy,ruleTarget,errorRuleSchema} from '../src/rules.js';
import {createStore} from '../src/state.js';
const policy={mode:'normal',maxRetries:3,retryableCodes:['SERVER','TRANSPORT'],initialDelayMs:100,maxDelayMs:100,jitterRatio:0};
const f={code:'PI_AI_ERROR',message:'Gateway failed an unclassified request'};
const error=errorSignature(f);
const rule=(scope,action,session='s')=>({id:randomUUID(),scope,target:ruleTarget(scope,session,'p','m'),action,error,confirmedRisk:false,createdAt:1,updatedAt:1});
test('scoped rule resolution: keep blocks wider overrides, removal restores inheritance',()=>{
 const global=rule('global','allow'),model=rule('model','deny'),session=rule('session','keep');
 const decide=(rules,s='s',p='p',m='m')=>decideFailure(rules,error,s,p,m,f,policy);
 assert.equal(decide([]).retryable,false);assert.equal(decide([global]).retryable,true);
 assert.equal(decide([global,model]).retryable,false);assert.equal(decide([global,model,session]).retryable,false);
 assert.equal(decide([global,model,session]).source,'session');assert.equal(decide([global,model],'other').source,'model');
 assert.equal(decide([global,model],'s','different').source,'global');assert.equal(decide([global],'s','different').retryable,true);
 const exact=errorSignature({...f,message:'A different gateway failure'});assert.equal(decideFailure([global],exact,'s','p','m',{...f,message:exact.message},policy).retryable,false);
 assert.equal(decideFailure([global],error,'s','p','m',f,policy,false).retryable,false);
});
test('risk confirmation enforced by persisted schema; protected lifecycle codes never allowed',()=>{
 assert.throws(()=>errorRuleSchema.parse(rule('global','allow')));
 const auth={code:'AUTH',message:'401 invalid_api_key',status:401};const r={...rule('model','allow'),error:errorSignature(auth)};
 assert.throws(()=>errorRuleSchema.parse(r));assert.equal(errorRuleSchema.parse({...r,confirmedRisk:true}).action,'allow');
 for(const code of ['ABORTED','CONTEXT_WINDOW_EXCEEDED','IMAGE_OFFLOAD_REQUIRED']){
  const e=errorSignature({code,message:'protected'});const override={...rule('global','allow'),error:e,confirmedRisk:true};
  assert.throws(()=>errorRuleSchema.parse(override));assert.equal(decideFailure([override],e,'s','p','m',{code,message:'protected'},policy).retryable,false);
 }
});
test('execution key is independent of which failure matched and preserves original failure facts',()=>{
 const r=rule('global','allow'),p=executionPolicy(policy,[r]);const original=Object.freeze({...f,status:503,providerRetryAfterMs:75,requestId:'diag'});
 const actual=decideFailure([r],error,'s','p','m',original,policy);assert.equal(actual.failure,original);
 assert.deepEqual(p.retryableCodes,['SERVER','TRANSPORT','PI_AI_ERROR']);assert.equal(p.maxRetries,3);assert.equal(policy.retryableCodes.length,2);
});
test('redaction removes nested JSON credentials, bearer values, URL query and request body',()=>{
 const fake='fake-value-never-a-real-secret';
 const sig=errorSignature({code:'AUTH',message:'401: '+JSON.stringify({code:'invalid_api_key',api_key:fake,'x-api-key':fake,clientSecret:fake,'x-access-token':fake,error:{message:'token='+fake,authorization:'Bearer '+fake,headers:{authorization:fake}},request:{messages:[{text:'private prompt'}]},url:'https://example.invalid/v1/'+fake+'?api_key='+fake,request_id:'random123'})});
 assert.equal(sig.status,401);assert.ok(!JSON.stringify(sig).includes(fake));assert.ok(!JSON.stringify(sig).includes('private prompt'));assert.ok(sig.message.includes('invalid_api_key'));
 const second=errorSignature({code:'AUTH',message:'401: '+JSON.stringify({code:'invalid_api_key',api_key:'other-secret','x-api-key':'other-secret',clientSecret:'other-secret','x-access-token':'other-secret',error:{message:'token=other-secret',authorization:'Bearer other-secret',headers:{authorization:'other-secret'}},request:{messages:[]},url:'https://example.invalid/v1/other-secret?api_key=other-secret',request_id:'random456'})});
 assert.equal(sig.fingerprint,second.fingerprint);
 assert.notEqual(errorSignature({code:'TRANSPORT',message:'TLS close_notify'}).fingerprint,sig.fingerprint);
});
test('inbox persists, deduplicates exact attempt seq, retains distinct TLS and AUTH attempts, and does not write configuration',async()=>{
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'error-inbox-'));try{
  const file=join(dir,'errors.json'),config=await createStore(join(dir,'state.json')),inbox=await createInbox(file);
  const entry=(seq,code='AUTH')=>{const e=errorSignature({code,message:code==='AUTH'?'401 invalid_api_key':'TLS closed'});return{id:'s:'+seq,groupId:groupId('p','m',e.fingerprint),sessionId:'s',provider:'p',model:'m',turn:1,step:1,seq,time:Date.now(),error:e,boundary:true,outcome:'observed'}};
  await inbox.record(entry(1));await inbox.record({...entry(1),outcome:'retrying'});await inbox.record(entry(1));await inbox.record(entry(2));await inbox.record(entry(3,'TRANSPORT'));
  assert.equal(inbox.snapshot().entries.length,3);assert.equal(inbox.snapshot().entries.find(x=>x.seq===1).outcome,'retrying');assert.equal(groupErrors(inbox.snapshot().entries).find(x=>x.error.code==='AUTH').count,2);
  assert.equal(groupErrors(inbox.snapshot().entries).length,2);assert.equal(groupErrors(inbox.snapshot().entries,'other').length,0);assert.equal(config.snapshot().revision,0);
  await inbox.record({...entry(1),outcome:'terminal'});await inbox.record({...entry(1),outcome:'scheduled'});assert.equal(inbox.snapshot().entries.find(x=>x.seq===1).outcome,'terminal');
  assert.equal((await createInbox(file)).snapshot().entries.length,3);assert.ok(!JSON.stringify(inbox.snapshot()).includes('private prompt'));
  await writeFile(file,'broken');await assert.rejects(createInbox(file),/读取失败/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('retention prunes expired entries from disk at startup',async()=>{
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'error-expiry-'));try{
  const e=errorSignature({code:'SERVER',message:'old gateway error'}),file=join(dir,'errors.json');
  const entry={id:'old:1',groupId:groupId('p','m',e.fingerprint),sessionId:'s',provider:'p',model:'m',turn:1,step:1,seq:1,time:Date.now()-31*86400000,error:e,boundary:true,outcome:'observed'};
  await writeFile(file,JSON.stringify({version:1,revision:1,entries:[entry]}));const inbox=await createInbox(file);
  assert.equal(inbox.snapshot().entries.length,0);assert.equal(JSON.parse(await readFile(file,'utf8')).entries.length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('inbox cap discards only oldest attempts and recognizes the actual adapter status wrapper',async()=>{
 assert.equal(errorSignature({code:'AUTH',message:'fixture API error (401): {"code":"invalid_api_key"}'}).status,401);
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'error-cap-'));try{
  const file=join(dir,'errors.json'),e=errorSignature({code:'SERVER',message:'bounded error'}),now=Date.now();
  const make=i=>({id:'cap:'+i,groupId:groupId('p','m',e.fingerprint),sessionId:'s',provider:'p',model:'m',turn:1,step:1,seq:i,time:now-1000+i,error:e,boundary:true,outcome:'observed'});
  await writeFile(file,JSON.stringify({version:1,revision:1,entries:Array.from({length:1000},(_,i)=>make(999-i))}));const inbox=await createInbox(file);await inbox.record(make(1000));
  assert.equal(inbox.snapshot().entries.length,1000);assert.equal(inbox.snapshot().entries[0].id,'cap:1000');assert.ok(!inbox.snapshot().entries.some(x=>x.id==='cap:0'));
  assert.equal(JSON.parse(await readFile(file,'utf8')).entries.length,1000);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('display families merge same provider/model status while retaining exact variants for rules',()=>{
 const a=errorSignature({code:'SERVER',status:502,message:'502 connection closed before message completed'});
 const b=errorSignature({code:'SERVER',status:502,message:'502 peer closed connection without TLS close_notify'});
 const c=errorSignature({code:'SERVER',status:503,message:'503 service unavailable'});
 const make=(id,error)=>({id,groupId:groupId('p','m',error.fingerprint),sessionId:'s',provider:'p',model:'m',turn:1,step:1,seq:Number(id),time:Date.now()+Number(id),error,boundary:true,outcome:'observed'});
 const families=groupErrorFamilies([make('1',a),make('2',b),make('3',c)]);
 assert.equal(families.length,2);const f502=families.find(x=>x.error.status===502);assert.equal(f502.count,2);assert.equal(f502.variantCount,2);assert.equal(f502.variants.length,2);assert.notEqual(f502.variants[0].id,f502.variants[1].id);
});

test('family display is stable, newest-first, session-isolated, and never counts the same event twice',()=>{
 const a=errorSignature({code:'SERVER',status:502,message:'502 closed'}),b=errorSignature({code:'SERVER',status:502,message:'502 TLS interrupted'});
 const make=(seq,error,provider='p',model='m',sessionId='s')=>({id:sessionId+':'+seq,groupId:groupId(provider,model,error.fingerprint),sessionId,provider,model,turn:1,step:1,seq,time:1000+seq,error,boundary:true,outcome:'terminal'});
 const older=make(1,a),newer=make(4,b),duplicate={...newer};
 const entries=[older,make(2,a,'other'),make(3,b,'p','other'),newer,duplicate,make(5,b,'p','m','other-session')];
 const scoped=groupErrorFamilies(entries,'s');assert.equal(scoped.length,3);const family=scoped.find(x=>x.provider==='p'&&x.model==='m');
 assert.equal(family.count,2);assert.equal(family.latest.seq,4);assert.equal(family.variants[0].error.fingerprint,b.fingerprint);assert.equal(family.firstSeen,1001);assert.equal(family.lastSeen,1004);
 assert.equal(groupErrors(entries,'s').find(x=>x.error.fingerprint===b.fingerprint&&x.model==='m').count,1);
 const key=family.familyKey;assert.equal(groupErrorFamilies([...entries,make(6,a)],'s')[0].familyKey,key);
 assert.equal(groupErrorFamilies(entries,'absent').length,0);
 const una=errorSignature({code:'AUTH',status:401,message:'401 invalid key'}),forbidden=errorSignature({code:'AUTH',status:403,message:'403 forbidden'});
 assert.equal(groupErrorFamilies([make(7,una),make(8,forbidden)]).length,2);
 const x=errorSignature({code:'PI_AI_ERROR',message:'unknown x'}),y=errorSignature({code:'PI_AI_ERROR',message:'unknown y'});
 assert.equal(groupErrorFamilies([make(9,x),make(10,y)]).length,2);
});
