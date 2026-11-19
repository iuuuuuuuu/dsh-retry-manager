import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../src/state.js';
import { modelKey } from '../src/policy.js';
import { installExecutor } from '../src/retry.js';

if (!process.env.DSH_DIST) throw new Error('DSH_DIST must point to the real DSH package.json or lib/bin.js. No stub fallback.');
const requireDsh = createRequire(resolve(process.env.DSH_DIST));
const load = name => import(pathToFileURL(requireDsh.resolve('@deepseek-ai/' + name)).href);
const {Context} = await load('cordis');
const projections = await load('dsh-session-projection');
const sessions = await load('dsh-session');
const agents = await load('dsh-agent');
const llm = await load('dsh-llm');
const prompt = await load('dsh-system-prompt');
const tools = await load('dsh-tools');
const native = await load('dsh-tool-executor-native');
const loop = await load('dsh-agent-loop');
const official = await load('dsh-llm-retry');
const dir = await mkdtemp(join(process.env.DSH_TEST_ROOT || tmpdir(), 'retry-integration-'));
const ctx = new Context();
const fibers = [];
async function mount(plugin, config) { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await(); return fiber; }
const counts = new Map(); const errors = [];
try {
  await mount(projections.SessionProjectionRegistry);
  await mount(sessions.default);
  await mount(agents.default);
  await mount(llm.default);
  await mount(prompt.default, {});
  await mount(tools.ToolsService);
  await mount(native);
  await mount(loop.AgentLoop, {agents: []});
  const state = await createStore(join(dir, 'state.json'));
  const observer = await mount({name:'retry-integration', inject:['llm','agents','tools','sessionProjections'], async apply(child) {
    await installExecutor(child, state, official.apply);
    class FailureAdapter extends llm.LlmAdapter {
      providerInfo(provider) { return {id: provider, name: provider}; }
      providerRetryPolicy() { return {mode:'normal',maxRetries:5,retryableCodes:['SERVER','TIMEOUT','TRANSPORT','EMPTY_RESPONSE','AUTH'],initialDelayMs:5,maxDelayMs:10,jitterRatio:0}; }
      async listModels(provider) { return [{id:'model-a',name:'model-a',provider}]; }
      async *stream(request) {
        const key=request.sessionId; const n=(counts.get(key)||0)+1; counts.set(key,n);
        const model=request.model;
        if (model==='tool-once' && n===1) {
          const block={type:'tool-call',id:'test-call',name:'count_side_effect',arguments:'{}'};
          yield {type:'block-start',index:0,blockType:'tool-call'};
          yield {type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:'{}'};
          yield {type:'block-end',index:0,block};
          yield {type:'finish',reason:{kind:'tool-calls'}}; return;
        }
        if (model==='auth' || model==='always-fail' || model==='cancel' || model==='freeze' || n < (model==='tool-once'?4:3)) {
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:'FAILED PARTIAL'};
          yield {type:'finish',reason:{kind:'error',failure:{code:model==='auth'?'AUTH':'SERVER',message:'Injected failure'}}}; return;
        }
        const block={type:'text',text:'OK'};
        yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'OK'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'stop'}};
      }
    }
    child.llm.registerAdapter(['integration'],new FailureAdapter());
    child.tools.register({name:'count_side_effect',description:'Count a real tool side effect',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{ counts.set('side-effects',(counts.get('side-effects')||0)+1); return 'done'; }});
    child.on('agent/error', e => errors.push(e));
  }});
  async function configure(change) { await state.update(state.snapshot().revision, change); }
  const created=[];
  async function agent(model='model-a') {
    const handle = await ctx.get('agents').create({sessionId:'retry-test-'+randomUUID(),agentOptions:{provider:'integration',model},meta:{cwd:dir}}); created.push(handle); return handle.agent;
  }
  async function run(agent) {
    const events=[]; const off=ctx.on('session/event',(session,event)=>{if(session.id===agent.id)events.push(event)});
    try { agent.followup(llm.createUserMessage({content:[{type:'text',text:'integration test'}],source:{kind:'user'}})); await agent.whenIdle(); return events; }
    finally { off(); }
  }
  let a=await agent(); await configure(s=>s.models[modelKey('integration','model-a')]=2);
  let events=await run(a); assert.equal(counts.get(a.id),3);assert.equal(events.filter(e=>e.type==='llm/retry').length,2);assert.equal(events.at(-1).type,'turn/end');assert.equal(events.at(-1).data.reason.kind,'completed');
  assert.equal(events.filter(e=>e.type==='user/message'&&e.data.content?.some?.(x=>x.text==='integration test')).length,1);
  assert.equal(events.filter(e=>e.type==='assistant/message').some(e=>JSON.stringify(e.data).includes('FAILED PARTIAL')),false);
  console.log('PASS model budget: 2 retries, 3 provider calls, no failed partial in history');
  a=await agent(); await configure(s=>s.sessions[a.id]=0); events=await run(a);assert.equal(counts.get(a.id),1);assert.equal(events.filter(e=>e.type==='llm/retry').length,0); console.log('PASS session zero overrides model rule');
  a=await agent('always-fail'); await configure(s=>s.defaultMaxRetries=3); events=await run(a);assert.equal(counts.get(a.id),4);assert.equal(events.filter(e=>e.type==='llm/retry').length,3);console.log('PASS exhausted budget: exactly initial + 3, no stacked official retries');
  const previousCount=counts.get(a.id);events=await run(a);assert.equal(counts.get(a.id),previousCount+4);assert.equal(events.filter(e=>e.type==='llm/retry').length,3);console.log('PASS a later turn receives a fresh finite retry budget');
  a=await agent('auth'); events=await run(a);assert.equal(counts.get(a.id),1);console.log('PASS permanent authentication failure is not retried');
  a=await agent('cancel'); let off=ctx.on('session/event',(session,event)=>{if(session.id===a.id&&event.type==='llm/retry')a.cancel({kind:'user'},{keepInbox:true})});events=await run(a);off();assert.equal(counts.get(a.id),1);assert.equal(events.filter(e=>e.type==='llm/retry-started').length,0);assert.equal(events.at(-1).data.reason.kind,'aborted');console.log('PASS cancel during backoff stops before another call');
  const one=await agent('always-fail'), two=await agent('always-fail');await configure(s=>{s.sessions[one.id]=1;s.sessions[two.id]=3;});await Promise.all([run(one),run(two)]);assert.equal(counts.get(one.id),2);assert.equal(counts.get(two.id),4);console.log('PASS parallel sessions keep independent budgets');
  a=await agent('freeze');await configure(s=>s.sessions[a.id]=2);let changed;
  off=ctx.on('session/event',(session,event)=>{if(session.id===a.id&&event.type==='llm/retry'&&!changed)changed=configure(s=>s.sessions[a.id]=8)});events=await run(a);off();await changed;assert.equal(counts.get(a.id),3);assert.equal(events.filter(e=>e.type==='llm/retry').length,2);console.log('PASS edits during backoff cannot reset an active budget');
  a=await agent('tool-once');events=await run(a);assert.equal(counts.get('side-effects'),1);assert.equal(counts.get(a.id),4);assert.equal(events.at(-1).data.reason.kind,'completed');console.log('PASS executed tool is not replayed after subsequent model failures');
  const before=counts.get(a.id);events=await run(a);assert.equal(counts.get(a.id),before+1);console.log('PASS next request starts independently after prior step');
  await Promise.all(created.map(h=>h.dispose()));
  console.log('ALL real DSH agent integration assertions passed.');
} finally {
  for(const fiber of fibers.reverse()) await fiber.dispose();
  await rm(dir,{recursive:true,force:true});
}
