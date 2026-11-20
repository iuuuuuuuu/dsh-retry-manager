import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import * as plugin from '../lib/index.js';

if (!process.env.DSH_DIST) throw new Error('DSH_DIST must name the actual DSH installation; no stub fallback.');
const requireDsh=createRequire(resolve(process.env.DSH_DIST));
const load=name=>import(pathToFileURL(requireDsh.resolve('@deepseek-ai/'+name)).href);
const [cordis,projections,sessions,agents,llm,prompt,tools,native,loop,pi]=await Promise.all(['cordis','dsh-session-projection','dsh-session','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-tool-executor-native','dsh-agent-loop','dsh-llm-pi-ai'].map(load));
const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-rules-'));
const stateFile=join(dir,'state.json'),inboxFile=join(dir,'errors.json');
const ctx=new cordis.Context(),fibers=[],handles=[],plans=new Map(),calls=new Map(),sideEffects=new Map(),records=new Map(),passes=[];
const previousArg=process.argv[1],oldKey=process.env.DSH_ERROR_RULE_FIXTURE_KEY;
process.argv[1]=requireDsh.resolve('@deepseek-ai/dsh/lib/bin.js');process.env.DSH_ERROR_RULE_FIXTURE_KEY='fixture-not-a-real-key';
const secret='private-fixture-credential';
const server=http.createServer(async(req,res)=>{
 try {
  assert.equal(req.url,'/v1/responses');let raw='';for await(const chunk of req)raw+=chunk;
  const marker=[...raw.matchAll(/CASE_[A-Z0-9]+/g)].at(-1)?.[0];const plan=plans.get(marker);assert.ok(plan,'undeclared test request');
  const n=(calls.get(marker)||0)+1;calls.set(marker,n);
  const spec=plan.events[Math.min(n-1,plan.events.length-1)];
  if(spec==='auth-http'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({code:'invalid_api_key',message:'Selected key invalid',api_key:secret,request_id:randomUUID()}));return;}
  if(spec==='retry-after'){res.writeHead(429,{'content-type':'application/json','retry-after':'30'});res.end(JSON.stringify({code:'rate_limit',message:'too many requests'}));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});let seq=0;
  const event=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
  event('response.created',{response:{id:marker+'-'+n,object:'response',status:'in_progress',output:[]}});
  if(spec==='ok'||spec==='tool'){
   const item=spec==='tool'?{id:'tool-'+marker,type:'function_call',call_id:'call-'+marker,name:'record_error_rule_side_effect',arguments:JSON.stringify({marker}),status:'completed'}
    :{id:'message-'+marker,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK '+marker,annotations:[]}]};
   event('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',...spec==='tool'?{arguments:''}:{content:[]}}});
   if(spec==='tool')event('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:item.arguments});
   else event('response.output_text.delta',{output_index:0,item_id:item.id,content_index:0,delta:item.content[0].text});
   event('response.output_item.done',{output_index:0,item});
   event('response.completed',{response:{id:marker+'-'+n,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  }else{
   const text=spec==='transport'?'connection closed before stream completed':spec==='temporary'?'Upstream service temporarily unavailable':spec==='custom'?'Gateway unclassified failure':spec==='different'?'Another unrelated gateway failure':spec==='quota'?'Insufficient quota':spec==='auth'?'Selected API key unavailable':String(spec);
   event('error',{code:spec==='auth'?'invalid_api_key':spec==='quota'?'insufficient_quota':'server_error',message:text});
  }
  res.end();
 }catch(error){console.error('FIXTURE ERROR',error);process.exitCode=1;res.destroy(error);}
});
const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
async function mount(plug,config){const f=ctx.plugin(plug,config);fibers.push(f);await f.await();return f;}
const routes=new Map();let retryFiber;const emitted=[];
const report=name=>{passes.push(name);console.log('PASS '+name)};
try{
 await mount(projections.SessionProjectionRegistry);await mount(sessions.default);await mount(agents.default);await mount(llm.default);await mount(prompt.default,{});await mount(tools.ToolsService);await mount(native);await mount(loop.AgentLoop,{agents:[]});
 const base={api:'openai-responses',baseURL:'http://127.0.0.1:'+server.address().port+'/v1',apiKeyEnv:'DSH_ERROR_RULE_FIXTURE_KEY',models:[{id:'m',contextWindow:1000000,maxTokens:1000},{id:'m2',contextWindow:1000000,maxTokens:1000}],retryPolicy:{mode:'normal',maxRetries:3,backoff:{initialDelayMs:100,maxDelayMs:100,jitterRatio:0}}};
 await mount(pi,{providers:{'rule-fixture':base,'other-fixture':base}});
 ctx.provide('connection');ctx.set('connection',{fetch:{register:route=>{routes.set(route.path,route);return()=>routes.delete(route.path)}}});
 await mount({name:'rule-test-effects',inject:['tools'],apply(child){child.tools.register({name:'record_error_rule_side_effect',description:'real once-only test side effect',parameters:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async({marker})=>{sideEffects.set(marker,(sideEffects.get(marker)||0)+1);return'done';}});child.on('session/event',(session,event)=>{emitted.push({sessionId:session.id,event});const old=records.get(session.id)??[];old.push(event);records.set(session.id,old);});}});
 retryFiber=await mount(plugin,{stateFile});
 async function request(body,query='') {const route=routes.get('/api/dsh-retry-manager');assert.ok(route,'real host API route registered');const res=await route.fetch(new Request('http://local/api/dsh-retry-manager'+query,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined));return {status:res.status,value:await res.json()};}
 async function view(sessionId){const x=await request(undefined,'?errors=1'+(sessionId?'&session='+sessionId:''));assert.equal(x.status,200);assert.equal(x.value.collectionError,null);return x.value;}
 async function configure(change){const old=(await request()).value;const x=await request({...change,revision:old.revision});assert.equal(x.status,200,JSON.stringify(x.value));return x.value;}
 async function setRule(group,scope,action,sessionId,confirmRisk=false){const old=await view();const x=await request({op:'error-rule',errorId:group.id,scope,action,sessionId,confirmRisk,revision:old.revision});assert.equal(x.status,200,JSON.stringify(x.value));return x.value;}
 async function removeRules(){for(const r of (await view()).rules){const x=await request({op:'remove-error-rule',ruleId:r.id,revision:(await view()).revision});assert.equal(x.status,200);}}
 async function agent(events,provider='rule-fixture',model='m') {const marker='CASE_'+randomUUID().replaceAll('-','').toUpperCase();plans.set(marker,{events});const handle=await ctx.get('agents').create({sessionId:'rule-test-'+randomUUID(),agentOptions:{provider,model},meta:{cwd:dir}});handles.push(handle);return {agent:handle.agent,marker,provider,model};}
 async function run(test,events){plans.set(test.marker,{events});calls.set(test.marker,0);const before=emitted.length;test.agent.followup(llm.createUserMessage({content:[{type:'text',text:test.marker}],source:{kind:'user'}}));await test.agent.whenIdle();await view();return emitted.slice(before).filter(e=>e.sessionId===test.agent.id).map(e=>e.event);}
 const kind=events=>events.filter(e=>e.type==='turn/end').at(-1)?.data.reason.kind;
 const retries=events=>events.filter(e=>e.type==='llm/retry');
 await configure({op:'default',maxRetries:2,retryIntervalMs:100});
 let a=await agent(['custom']),events=await run(a,['custom']);assert.equal(calls.get(a.marker),1);assert.equal(kind(events),'error');let groups=await view(a.agent.id);let custom=groups.groups.find(x=>x.error.message.includes('Gateway unclassified'));assert.ok(custom);assert.equal(custom.count,1);assert.equal(custom.current.action,'keep');assert.equal(custom.current.retryable,false);report('unclassified failure automatically archived without changing original recovery');
 const configRevision=groups.revision;await run(a,['custom']);groups=await view(a.agent.id);assert.equal(groups.revision,configRevision);assert.equal(groups.groups[0].count,2);report('same-error attempts deduplicate by event, aggregate, and never change settings revision');
 await setRule(custom,'model','allow',a.agent.id);assert.equal(calls.get(a.marker),1,'rule save must not restart previous failed turn');events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),2);assert.equal(kind(events),'completed');assert.equal(retries(events).length,1);assert.equal(retries(events)[0].data.failure.code,'PI_AI_ERROR');report('model-specific explicit allow retries the real Responses request and preserves original code');
 let b=await agent(['custom','ok']);events=await run(b,['custom','ok']);assert.equal(calls.get(b.marker),2);let other=await agent(['custom','ok'],'other-fixture');await run(other,['custom','ok']);assert.equal(calls.get(other.marker),1);let secondModel=await agent(['custom','ok'],'rule-fixture','m2');await run(secondModel,['custom','ok']);assert.equal(calls.get(secondModel.marker),1);report('model rule matches exact provider+model, not another provider or model');
 await setRule(custom,'session','keep',a.agent.id);events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),1);assert.equal(kind(events),'error');const sRule=(await view()).rules.find(r=>r.scope==='session');await configure({op:'remove-error-rule',ruleId:sRule.id});events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),2);report('session keep masks wider allow; removing it restores inherited model rule');
 await removeRules();const globalRequest=await request({op:'error-rule',revision:(await view()).revision,errorId:custom.id,scope:'global',action:'allow',sessionId:a.agent.id});assert.equal(globalRequest.status,400);report('global allow cannot bypass explicit risk confirmation through the API');await setRule(custom,'global','allow',a.agent.id,true);events=await run(other,['custom','ok']);assert.equal(calls.get(other.marker),2);await setRule(custom,'model','deny',a.agent.id);events=await run(b,['custom','ok']);assert.equal(calls.get(b.marker),1);await setRule(custom,'session','allow',a.agent.id);events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),2);report('global allow, model deny and session allow resolve in declared specificity order');
 await removeRules();events=await run(a,['temporary','ok']);assert.equal(calls.get(a.marker),2);const transient=(await view(a.agent.id)).groups.find(g=>g.error.message==='Upstream service temporarily unavailable');assert.ok(transient);await setRule(transient,'model','deny',a.agent.id);events=await run(a,['temporary','ok']);assert.equal(calls.get(a.marker),1);assert.equal(kind(events),'error');await setRule(transient,'model','keep',a.agent.id);events=await run(a,['temporary','ok']);assert.equal(calls.get(a.marker),2);report('deny excludes a normally retryable SERVER signature; keep restores the original transient recovery');
 await removeRules();await setRule(custom,'model','allow',a.agent.id);events=await run(a,['different','ok']);assert.equal(calls.get(a.marker),1);assert.equal(kind(events),'error');report('allowing one PI_AI_ERROR signature never opens the entire error code');
 events=await run(a,['temporary','custom','custom']);assert.equal(calls.get(a.marker),3);assert.deepEqual(retries(events).map(e=>e.data.retry),[1,2]);assert.equal(new Set(retries(events).map(e=>e.data.retryId)).size,1);assert.equal(kind(events),'error');report('mixed native SERVER and custom PI_AI_ERROR share one finite official budget');
 await configure({op:'session',sessionId:a.agent.id,maxRetries:0});events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),1);await configure({op:'session',sessionId:a.agent.id,maxRetries:null});report('explicit allow still respects session retry count zero');
 let cancel=await agent(['custom']);const off=ctx.on('session/event',(session,event)=>{if(session.id===cancel.agent.id&&event.type==='llm/retry')cancel.agent.cancel({kind:'user'},{keepInbox:true});});events=await run(cancel,['custom']);off();assert.equal(calls.get(cancel.marker),1);assert.equal(kind(events),'aborted');report('custom error recovery remains cancellable before the next request');
 await removeRules();let auth=await agent(['transport','auth-http']);events=await run(auth,['transport','auth-http']);assert.equal(calls.get(auth.marker),2);const authView=await view(auth.agent.id);const authGroup=authView.groups.find(x=>x.error.code==='AUTH'),transport=authView.groups.find(x=>x.error.code==='TRANSPORT');assert.ok(authGroup&&transport);assert.equal(authGroup.count,1);assert.equal(transport.count,1);assert.equal(authGroup.latest.outcome,'terminal');assert.equal(transport.latest.outcome,'retrying');assert.ok(authGroup.requiresConfirmation);assert.ok(!JSON.stringify(authView).includes(secret));assert.ok(!(await readFile(inboxFile,'utf8')).includes(secret));report('TLS-like transport and subsequent actual HTTP 401 stay distinct; credentials absent from inbox and disk');
 const rejected=await request({op:'error-rule',revision:authView.revision,errorId:authGroup.id,scope:'model',action:'allow',sessionId:auth.agent.id});assert.equal(rejected.status,400);await setRule(authGroup,'model','allow',auth.agent.id,true);events=await run(auth,['auth-http','ok']);assert.equal(calls.get(auth.marker),2);assert.equal(kind(events),'completed');events=await run(auth,['auth','ok']);assert.equal(calls.get(auth.marker),1);report('AUTH override requires backend risk confirmation and matches only the selected 401 signature');
 const stale=(await view()).revision;await configure({op:'default',maxRetries:2});const conflict=await request({op:'error-rule',revision:stale,errorId:custom.id,scope:'model',action:'allow',sessionId:a.agent.id});assert.equal(conflict.status,409);report('stale rule writes conflict instead of overwriting another window');
 await removeRules();await setRule(custom,'model','allow',a.agent.id);let edit;const stop=ctx.on('session/event',(session,event)=>{if(session.id===a.agent.id&&event.type==='llm/retry'&&!edit)edit=setRule(custom,'model','deny',a.agent.id);});events=await run(a,['custom']);stop();await edit;assert.equal(calls.get(a.marker),3);assert.deepEqual(retries(events).map(e=>e.data.retry),[1,2]);events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),1);report('rule edits during backoff do not reset or replace captured step policy; next step sees them');
 await removeRules();await setRule(custom,'model','allow',a.agent.id);let tool=await agent(['tool','custom','ok']);events=await run(tool,['tool','custom','ok']);assert.equal(kind(events),'completed');assert.equal(calls.get(tool.marker),3);assert.equal(sideEffects.get(tool.marker),1);report('custom-rule recovery never repeats an already executed tool');
 const beforePersist=await view();const beforeEntries=beforePersist.groups.reduce((n,g)=>n+g.count,0);await retryFiber.dispose();retryFiber=await mount(plugin,{stateFile});const resumed=await view();assert.equal(resumed.rules.length,beforePersist.rules.length);assert.equal(resumed.groups.reduce((n,g)=>n+g.count,0),beforeEntries);events=await run(a,['custom','ok']);assert.equal(calls.get(a.marker),2);report('inbox and rule configuration survive plugin reactivation');
 // Exercise the actual passive-history API with a live observed log, no Agent activation or prompt.
 const queryModule=await load('dsh-session-query');await mount(queryModule.default,{});
 const sync=await request({op:'sync-errors',sessionId:a.agent.id});assert.equal(sync.status,200,JSON.stringify(sync.value));assert.equal(calls.get(a.marker),2);const afterSync=(await view(a.agent.id)).groups.reduce((n,g)=>n+g.count,0);const again=await request({op:'sync-errors',sessionId:a.agent.id});assert.equal(again.status,200);assert.equal((await view(a.agent.id)).groups.reduce((n,g)=>n+g.count,0),afterSync);report('passive history import is idempotent and never reruns previous requests');
 assert.equal(process.exitCode,undefined);console.log('ALL REAL ERROR RULE CHECKS PASSED '+passes.length);
}catch(error){console.error(error);process.exitCode=1;}finally{for(const h of handles)await h.dispose();for(const f of fibers.reverse())await f.dispose();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});process.argv[1]=previousArg;if(oldKey===undefined)delete process.env.DSH_ERROR_RULE_FIXTURE_KEY;else process.env.DSH_ERROR_RULE_FIXTURE_KEY=oldKey;}
