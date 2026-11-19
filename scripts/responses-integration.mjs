import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/state.js';
import { installExecutor } from '../lib/retry.js';

if (!process.env.DSH_DIST) throw new Error('DSH_DIST must point to a real DSH package.json or lib/bin.js. No stub fallback.');
const requireDsh = createRequire(resolve(process.env.DSH_DIST));
const load = name => import(pathToFileURL(requireDsh.resolve('@deepseek-ai/' + name)).href);
const [cordis, projections, sessions, agents, llm, prompt, tools, native, loop, pi, official] = await Promise.all([
  'cordis', 'dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools',
  'dsh-tool-executor-native', 'dsh-agent-loop', 'dsh-llm-pi-ai', 'dsh-llm-retry'
].map(load));
const plans = new Map();
const captures = new Map();
const sideEffects = new Map();
const fixtureErrors = [];
const permanentCases = new Map([
  ['auth', {code:'invalid_api_key',message:'Invalid API key'}],
  ['quota', {code:'insufficient_quota',message:'Insufficient quota'}],
  ['config', {code:'invalid_config',message:'Invalid configuration'}],
  ['unknown', {code:'unknown_error',message:'Unexpected provider failure'}],
  ['misleading-auth', {code:'server_error',message:'Upstream service temporarily unavailable: invalid API key'}],
  ['misleading-quota', {code:'server_error',message:'Upstream service temporarily unavailable; insufficient_quota'}],
  ['misleading-config', {code:'invalid_config',message:'Upstream service temporarily unavailable'}]
]);
const server = http.createServer(async (req, res) => {
  try {
    assert.ok(req.url.endsWith('/responses'), 'test must exercise the real Responses HTTP adapter');
    let raw = '';
    for await (const part of req) raw += part;
    const request = JSON.parse(raw);
    const marker = [...raw.matchAll(/CASE_[A-Z0-9_]+/g)].at(-1)?.[0];
    const plan = plans.get(marker);
    assert.ok(plan, 'unexpected provider request must not silently pass');
    const calls = captures.get(marker) ?? [];
    calls.push({time: Date.now(), request});
    captures.set(marker, calls);
    const attempt = calls.length;
    let sequence = 0;
    const event = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({type,sequence_number:sequence++,...data}) + '\n\n');
    const start = () => {
      res.writeHead(200, {'content-type':'text/event-stream'});
      event('response.created', {response:{id:marker+'-'+attempt,object:'response',status:'in_progress',output:[]}});
    };
    const textItem = text => ({id:'message-'+attempt,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
    const success = () => {
      start();
      const item = textItem('OK '+marker);
      event('response.output_item.added', {output_index:0,item:{...item,status:'in_progress',content:[]}});
      event('response.output_text.delta', {output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text});
      event('response.output_item.done', {output_index:0,item});
      event('response.completed', {response:{id:marker+'-'+attempt,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
      res.end();
    };
    if (plan.tool && attempt === 1) {
      start();
      const item = {id:'tool-item',type:'function_call',call_id:'side-effect-'+marker,name:'record_side_effect',arguments:JSON.stringify({marker}),status:'completed'};
      event('response.output_item.added', {output_index:0,item:{...item,arguments:'',status:'in_progress'}});
      event('response.function_call_arguments.delta', {output_index:0,item_id:item.id,delta:item.arguments});
      event('response.output_item.done', {output_index:0,item});
      event('response.completed', {response:{id:marker+'-'+attempt,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
      res.end();
      return;
    }
    const failureAttempt = attempt - (plan.tool ? 1 : 0);
    if (plan.initial502 && failureAttempt === 1) {
      res.writeHead(502, {'content-type':'application/json'});
      res.end(JSON.stringify({code:'upstream_submission_unconfirmed',message:'connection closed before message completed',type:'proxy_error'}));
      return;
    }
    if (plan.failures !== undefined && failureAttempt > plan.failures) { success(); return; }
    start();
    if (plan.partial) {
      const partial = textItem('FAILED_PARTIAL_MUST_NOT_ENTER_HISTORY');
      event('response.output_item.added', {output_index:0,item:{...partial,status:'in_progress',content:[]}});
      event('response.output_text.delta', {output_index:0,content_index:0,item_id:partial.id,delta:partial.content[0].text});
    }
    const failure = plan.permanent ? permanentCases.get(plan.permanent) : {code:'server_error',message:plan.message ?? 'Upstream service temporarily unavailable'};
    assert.ok(failure, 'test failure case must be declared');
    if (plan.mode === 'response.failed') event('response.failed', {response:{id:marker+'-'+attempt,object:'response',status:'failed',error:failure,output:[]}});
    else event('error', failure);
    res.end();
  } catch (error) {
    // Keep a server-fixture defect visibly different from a retryable provider failure.
    fixtureErrors.push(error);
    console.error('FIXTURE ERROR', error);
    res.destroy(error);
  }
});
const sockets = new Set();
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const address = server.address();
assert.ok(address && typeof address === 'object');
const dir = await mkdtemp(join(process.env.DSH_TEST_ROOT || tmpdir(), 'retry-responses-'));
const ctx = new cordis.Context();
const fibers = [], handles = [], passed = [];
const credentialName = 'DSH_RETRY_LOCAL_FIXTURE_KEY';
const previousCredential = process.env[credentialName];
process.env[credentialName] = 'fixture-not-a-real-key';
async function mount(plugin, config) { const fiber = ctx.plugin(plugin, config); fibers.push(fiber); await fiber.await(); return fiber; }
const pass = message => { passed.push(message); console.log('PASS ' + message); };
try {
  await mount(projections.SessionProjectionRegistry);
  await mount(sessions.default);
  await mount(agents.default);
  await mount(llm.default);
  await mount(prompt.default, {});
  await mount(tools.ToolsService);
  await mount(native);
  await mount(loop.AgentLoop, {agents:[]});
  const baseProfile = {api:'openai-responses',baseURL:'http://127.0.0.1:'+address.port+'/v1',apiKeyEnv:credentialName,
    models:[{id:'fixture-model',contextWindow:1000000,maxTokens:1000}],retryPolicy:{mode:'normal',maxRetries:100,backoff:{initialDelayMs:100,maxDelayMs:100,jitterRatio:0}}};
  await mount(pi, {providers:{'local-fixture':baseProfile,'no-server-fixture':{...baseProfile,retryPolicy:{...baseProfile.retryPolicy,retryableCodes:['TIMEOUT']}}}});
  const state = await createStore(join(dir, 'state.json'));
  const update = change => state.update(state.snapshot().revision, change);
  await update(s => {s.defaultMaxRetries=4;s.retryIntervalMs=100;});
  await mount({name:'retry-responses-test',inject:['agents','sessionProjections','tools'],async apply(child) {
    await installExecutor(child, state, official.apply);
    child.tools.register({name:'record_side_effect',description:'Record one actual tool side effect',parameters:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async({marker})=>{sideEffects.set(marker,(sideEffects.get(marker)||0)+1);return 'recorded';}});
  }});
  async function create(plan, provider='local-fixture') {
    const marker='CASE_'+randomUUID().replaceAll('-','').toUpperCase();plans.set(marker,plan);
    const handle=await ctx.get('agents').create({sessionId:'responses-test-'+randomUUID(),meta:{cwd:dir},agentOptions:{provider,model:'fixture-model'}});handles.push(handle);
    return {marker,agent:handle.agent};
  }
  async function run(test, onRetry) {
    const events=[];let callbackTask;
    const off=ctx.on('session/event',(session,event)=>{if(session.id!==test.agent.id)return;events.push(event);if(event.type==='llm/retry'&&onRetry)callbackTask=onRetry(event);});
    try {test.agent.followup(llm.createUserMessage({content:[{type:'text',text:test.marker}],source:{kind:'user'}}));await test.agent.whenIdle();if(callbackTask)await callbackTask;return events;}finally{off();}
  }
  const retries = events => events.filter(e=>e.type==='llm/retry');
  const reason = events => events.filter(e=>e.type==='turn/end').at(-1)?.data.reason;
  const failureChunks = events => events.filter(e=>e.type==='assistant/attempt').flatMap(e=>llm.expandAssistantStream(e.data.stream)).filter(x=>x.chunk.type==='finish').map(x=>x.chunk.reason.failure).filter(Boolean);
  const calls = test => captures.get(test.marker) ?? [];
  for (const mode of ['error','response.failed']) {
    for (const message of ['Upstream service temporarily unavailable','Upstream request failed, please try again later']) {
      const test=await create({mode,message,initial502:true,failures:2,partial:true});
      const events=await run(test);assert.equal(calls(test).length,3);assert.equal(reason(events).kind,'completed');assert.equal(retries(events).length,2);
      assert.deepEqual(retries(events).map(e=>e.data.retry),[1,2]);assert.equal(new Set(retries(events).map(e=>e.data.retryId)).size,1);
      assert.deepEqual(retries(events).map(e=>e.data.delayMs),[100,100]);assert.ok(retries(events).every(e=>e.data.failure.code==='SERVER'));
      const originals=failureChunks(events);assert.equal(originals[0].code,'SERVER');assert.equal(originals[1].code,'PI_AI_ERROR');assert.ok(originals[1].message.includes(message));
      assert.equal(calls(test).some(c=>JSON.stringify(c.request).includes('FAILED_PARTIAL_MUST_NOT_ENTER_HISTORY')),false);
      assert.equal(events.filter(e=>e.type==='assistant/message').some(e=>JSON.stringify(e.data.message).includes('FAILED_PARTIAL_MUST_NOT_ENTER_HISTORY')),false);
      pass('real Responses '+mode+': 502 then '+message+' retries to success in one budget, preserving original failed facts');
    }
  }
  let test=await create({mode:'response.failed',initial502:true});await update(s=>s.sessions[test.agent.id]=2);let events=await run(test);
  assert.equal(calls(test).length,3);assert.deepEqual(retries(events).map(e=>e.data.retry),[1,2]);assert.equal(reason(events).kind,'error');assert.equal(reason(events).error.code,'PI_AI_ERROR');pass('mixed SERVER and normalized upstream errors exhaust one finite budget, never reset it');
  test=await create({mode:'error'});await update(s=>s.sessions[test.agent.id]=0);events=await run(test);assert.equal(calls(test).length,1);assert.equal(retries(events).length,0);assert.equal(reason(events).kind,'error');pass('session zero still disables retries for recognized temporary upstream errors');
  test=await create({mode:'error',failures:1},'no-server-fixture');events=await run(test);assert.equal(calls(test).length,1);assert.equal(retries(events).length,0);pass('provider retryable-code policy excluding SERVER is still respected');
  test=await create({mode:'error'});await update(s=>s.retryIntervalMs=5000);events=await run(test,()=>test.agent.cancel({kind:'user'},{keepInbox:true}));assert.equal(calls(test).length,1);assert.equal(events.filter(e=>e.type==='llm/retry-started').length,0);assert.equal(reason(events).kind,'aborted');pass('recognized upstream recovery remains cancellable before another request');
  await update(s=>s.retryIntervalMs=100);
  for(const permanent of permanentCases.keys()) {
    test=await create({mode:'response.failed',permanent});events=await run(test);assert.equal(calls(test).length,1,permanent);assert.equal(retries(events).length,0,permanent);assert.equal(reason(events).kind,'error');pass('real Responses permanent/unknown '+permanent+' is not retried');
  }
  test=await create({mode:'response.failed',tool:true,initial502:true,failures:2,partial:true});events=await run(test);assert.equal(calls(test).length,4);assert.equal(sideEffects.get(test.marker),1);assert.equal(reason(events).kind,'completed');assert.equal(retries(events).length,2);pass('real tool executed before failure is not replayed by the recovered Responses step');
  test=await create({mode:'error'});let edited=false;events=await run(test,()=>{if(!edited){edited=true;return update(s=>{s.defaultMaxRetries=1;s.retryIntervalMs=200;});}});assert.equal(calls(test).length,5);assert.deepEqual(retries(events).map(e=>e.data.delayMs),[100,100,100,100]);
  const priorCalls=calls(test).length;events=await run(test);assert.equal(calls(test).length-priorCalls,2);assert.deepEqual(retries(events).map(e=>e.data.delayMs),[200]);pass('recognized error path preserves captured settings and adopts edits on next failed step');
  await update(s=>{s.defaultMaxRetries=2;s.retryIntervalMs=5000;});test=await create({mode:'error',initial502:true,failures:2});events=await run(test);assert.equal(calls(test).length,3);assert.equal(reason(events).kind,'completed');const waits=retries(events),starts=events.filter(e=>e.type==='llm/retry-started');assert.deepEqual(waits.map(e=>e.data.delayMs),[5000,5000]);for(let i=0;i<2;i++)assert.ok(starts[i].time-waits[i].time>=4900,'the configured 5000ms must actually elapse');pass('exact reported chain now succeeds with two actual 5000ms waits');
  assert.equal(fixtureErrors.length,0,'a fixture exception must never count as provider recovery');
  console.log('ALL REAL RESPONSES CHECKS PASSED '+passed.length);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const handle of handles) await handle.dispose();
  for (const fiber of fibers.reverse()) await fiber.dispose();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve=>server.close(resolve));
  await rm(dir,{recursive:true,force:true});
  if (previousCredential === undefined) delete process.env[credentialName];else process.env[credentialName]=previousCredential;
}
