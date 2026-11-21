import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createInbox, groupErrors, groupErrorFamilies, errorFamilyKey, partitionErrorEntries } from './errors.js';
import { createCollector } from './observations.js';
import { decideFailure, ruleTarget, needsRiskConfirmation, NEVER_OVERRIDE } from './rules.js';
import { createStore } from './state.js';
import { count, effectivePolicy, modelKey, MAX_RETRIES, MIN_RETRY_INTERVAL_MS, MAX_RETRY_INTERVAL_MS } from './policy.js';
import { installExecutor } from './retry.js';

export const name = 'retry-manager';
export const inject = ['agents', 'sessionProjections', 'llm'];
const route = '/api/dsh-retry-manager';
const identity = z.string().min(1).max(240).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v));
const retries = z.number().int().min(0).max(MAX_RETRIES);
const revision = z.number().int().nonnegative();
const mutation = z.discriminatedUnion('op', [
  z.object({op: z.literal('default'), revision, maxRetries: retries.nullable(), retryIntervalMs: z.number().int().min(MIN_RETRY_INTERVAL_MS).max(MAX_RETRY_INTERVAL_MS).multipleOf(100).nullable().optional()}).strict(),
  z.object({op: z.literal('model'), revision, provider: identity, model: identity, maxRetries: retries.nullable()}).strict(),
  z.object({op: z.literal('session'), revision, sessionId: identity, maxRetries: retries.nullable()}).strict(),
  z.object({op:z.literal('error-rule'), revision, errorId:z.string().regex(/^[a-f0-9]{64}$/), scope:z.enum(['session','model','global']), action:z.enum(['keep','allow','deny']), sessionId:identity.optional(), confirmRisk:z.boolean().default(false)}).strict(),
  z.object({op:z.literal('remove-error-rule'), revision, ruleId:z.string().uuid()}).strict(),
  z.object({op:z.literal('ignore-error'),revision,errorId:z.string().regex(/^[a-f0-9]{64}$/),sessionId:identity.optional()}).strict(),
  z.object({op:z.literal('restore-error'),revision,familyKey:z.string().min(1).max(1200),sessionId:identity.optional()}).strict(),
  z.object({op:z.literal('sync-errors'), sessionId:identity}).strict(),
  z.object({op: z.literal('cancel'), sessionId: identity, retryId: identity}).strict()
]);
const response = (status, body) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});

async function officialExecutor() {
  // Profile-linked plugins need not resolve packages in the runtime's separate tree.
  // Resolve from the actual process entrypoint, never a machine-specific location.
  let resolved;
  try { resolved = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-llm-retry'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !process.argv[1] || !isAbsolute(process.argv[1])) throw error;
    resolved = createRequire(process.argv[1]).resolve('@deepseek-ai/dsh-llm-retry');
  }
  return (await import(pathToFileURL(resolved).href)).apply;
}

export async function apply(ctx, config = {}) {
  const stateFile = config.stateFile ?? join(process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE || 'default'), 'retry-manager', 'state.json');
  const store = await createStore(stateFile);
  const inbox = await createInbox(join(dirname(stateFile), 'errors.json'));
  const collector = createCollector(ctx, inbox);
  const active = new WeakMap();
  let disposed = false;
  const running = new Set();
  ctx.on('session/event', (session, event) => {
    collector.observe(session, event);
    if (event.type === 'llm/retry') active.set(session, {...event.data, phase: 'waiting', until: event.time + event.data.delayMs});
    else if (event.type === 'llm/retry-started') {
      const current = active.get(session);
      if (current?.retryId === event.data.retryId) active.set(session, {...current, phase: 'retrying'});
    } else if (['step/start', 'step/end', 'turn/end'].includes(event.type)) active.delete(session);
  });
  await installExecutor(ctx, store, await officialExecutor(), collector);

  function sessionFor(id) {
    const agent = ctx.agents.get(id);
    if (!agent) { const e = new Error('该对话尚未加载，请打开对话后重试'); e.status = 404; throw e; }
    return agent;
  }
  function currentView(sessionId) {
    const state = store.snapshot();
    const result = {version: '0.2.0', revision: state.revision, defaultMaxRetries: state.defaultMaxRetries, retryIntervalMs: state.retryIntervalMs,
      models: Object.entries(state.models).map(([key, maxRetries]) => { const [provider, model] = JSON.parse(key); return {provider, model, maxRetries}; })};
    if (sessionId) {
      const agent = sessionFor(sessionId);
      const selection = agent.model.current() ?? agent.session.requestHeader()?.config ?? agent.options;
      const provider = selection?.provider;
      const model = selection?.model;
      let inherited;
      if (provider) { try { inherited = ctx.llm.providerRetryPolicy(provider); } catch { /* Deleted route: keep overrides editable. */ } }
      const effective = effectivePolicy(state, sessionId, provider, model, inherited);
      const retry = active.get(agent.session);
      result.session = {sessionId, provider, model, override: state.sessions[sessionId] ?? null,
        source: effective.source, maxRetries: effective.policy.maxRetries, retryIntervalMs: state.retryIntervalMs,
        active: retry ? {retryId: retry.retryId, retry: retry.retry, maxRetries: retry.maxRetries, phase: retry.phase, until: retry.until, code: retry.failure.code} : null};
    }
    return result;
  }
  function errorsView(sessionId) {
    const state=store.snapshot(),collected=inbox.snapshot();
    function grouped(entries) {
      const groups=groupErrors(entries,sessionId).map(group=>{
        let inherited;
        try { inherited=ctx.llm.providerRetryPolicy(group.provider); } catch { /* Removed route stays inspectable. */ }
        const base=effectivePolicy(state,sessionId??group.latest.sessionId,group.provider,group.model,inherited).policy;
        const decision=decideFailure(state.errorRules,group.error,sessionId??group.latest.sessionId,group.provider,group.model,group.error,base,inherited!==undefined);
        const {failure:ignored,...view}=decision;
        return {...group,current:{...view,canOverride:view.canOverride&&group.latest.boundary},
          requiresConfirmation:needsRiskConfirmation(group.error),protected:NEVER_OVERRIDE.has(group.error.code)};
      });
      const byId=new Map(groups.map(group=>[group.id,group]));
      const families=groupErrorFamilies(entries,sessionId).map(family=>({...family,variants:family.variants.map(group=>byId.get(group.id))}));
      return {groups,families};
    }
    const scoped=collected.entries.filter(entry=>!sessionId||entry.sessionId===sessionId);
    const partition=partitionErrorEntries(scoped,state.errorRules,collected.ignored);
    const configured=grouped(partition.configured).families;
    const configuredIds=new Set(configured.flatMap(family=>family.variants.map(group=>group.id)));
    for (const item of collected.ignored) {
      const family=grouped([item.sample]).families[0],group=family?.variants[0];
      if (!group?.current.ruleId||configuredIds.has(group.id)) continue;
      const variant={...group,count:0,occurrences:[],summaryOnly:true};
      const existing=configured.find(candidate=>candidate.familyKey===family.familyKey);
      if (existing) existing.variants.push(variant);
      else configured.push({...family,summaryOnly:true,count:0,variants:[variant]});
      configuredIds.add(group.id);
    }
    const ignored=grouped(partition.ignored).families,seen=new Set(ignored.map(family=>family.familyKey));
    for (const item of collected.ignored) {
      if (seen.has(item.key)||sessionId&&item.sample.sessionId!==sessionId) continue;
      const family=grouped([item.sample]).families[0];
      if (family) ignored.push({...family,summaryOnly:true,count:0,
        variants:family.variants.map(group=>({...group,count:0,occurrences:[]}))});
    }
    return {revision:state.revision,inboxRevision:collected.revision,visibilityRevision:collected.visibilityRevision,
      ...grouped(collected.entries),
      views:{pending:grouped(partition.pending).families,configured,ignored},
      rules:state.errorRules,collectionError:collector.status(),retentionDays:30,maxEvents:1000,sessionId:sessionId??null};
  }

  async function mutate(input) {
    if (disposed) throw new Error('插件正在重新加载，请稍后再试');
    if (input.op === 'sync-errors') {
      await collector.sync(input.sessionId);
      return errorsView(input.sessionId);
    }
    if (input.op === 'ignore-error' || input.op === 'restore-error') {
      await collector.drain();
      if (input.op==='restore-error') await inbox.setIgnored(input.revision,input.familyKey,null);
      else {
        const snapshot=inbox.snapshot();
        const group=groupErrors(snapshot.entries,input.sessionId).find(group=>group.id===input.errorId);
        if (!group) { const e=new Error('该错误已不在待处理记录中，请刷新');e.status=404;throw e; }
        await inbox.setIgnored(input.revision,errorFamilyKey(group.provider,group.model,group.error),group.latest);
      }
      return errorsView(input.sessionId);
    }
    if (input.op === 'error-rule') {
      await collector.drain();
      const snapshot=inbox.snapshot();
      const available=[...snapshot.entries,...snapshot.ignored.map(item=>item.sample)];
      const group = groupErrors(available).find(group => group.id === input.errorId);
      if (!group) { const e = new Error('该错误已超出保留范围，请刷新收件箱'); e.status=404; throw e; }
      const sessionId = input.sessionId ?? group.latest.sessionId;
      if (input.scope === 'session' && !available.some(entry => entry.groupId === group.id && entry.sessionId === sessionId)) {
        const e=new Error('目标会话没有该错误记录'); e.status=400; throw e;
      }
      if ((input.action !== 'keep' && NEVER_OVERRIDE.has(group.error.code)) || (input.action === 'allow' && !group.latest.boundary)) {
        const e = new Error('该错误未进入模型请求恢复边界，或由取消／专属恢复处理，不能强制重试'); e.status=400; throw e;
      }
      if (input.action === 'allow' && (needsRiskConfirmation(group.error) || input.scope==='global') && !input.confirmRisk) {
        const e = new Error('放行认证／配额等风险错误或全局规则需要额外确认；每次重试可能产生费用'); e.status=400; throw e;
      }
      const target = ruleTarget(input.scope, sessionId, group.provider, group.model), now=Date.now();
      await store.update(input.revision, draft => {
        const existing = draft.errorRules.find(rule => rule.scope===input.scope && rule.target===target && rule.error.fingerprint===group.error.fingerprint);
        draft.errorRules = draft.errorRules.filter(rule => !(rule.scope===input.scope && rule.target===target && rule.error.fingerprint===group.error.fingerprint));
        draft.errorRules.push({id:existing?.id ?? randomUUID(), scope:input.scope, target, action:input.action, error:group.error,
          confirmedRisk:input.action==='allow' && input.confirmRisk, createdAt:existing?.createdAt ?? now, updatedAt:now});
      });
      return errorsView(input.scope==='session' ? sessionId : undefined);
    }
    if (input.op === 'remove-error-rule') {
      await store.update(input.revision, draft => {
        if (!draft.errorRules.some(rule => rule.id===input.ruleId)) { const e=new Error('该规则已被移除，请刷新'); e.status=409; throw e; }
        draft.errorRules = draft.errorRules.filter(rule => rule.id!==input.ruleId);
      });
      return errorsView();
    }
    if (input.op === 'cancel') {
      const agent = sessionFor(input.sessionId);
      if (active.get(agent.session)?.retryId !== input.retryId) { const e = new Error('该次重试已结束，未停止后续任务'); e.status = 409; throw e; }
      agent.cancel({kind: 'user'}, {keepInbox: true});
      await agent.whenIdle();
      return currentView(input.sessionId);
    }
    if (input.op === 'session') sessionFor(input.sessionId);
    await store.update(input.revision, draft => {
      if (input.op === 'default') {
        draft.defaultMaxRetries = input.maxRetries;
        if (input.retryIntervalMs !== undefined) draft.retryIntervalMs = input.retryIntervalMs;
      }
      if (input.op === 'model') {
        const key = modelKey(input.provider, input.model);
        if (input.maxRetries === null) delete draft.models[key]; else draft.models[key] = count(input.maxRetries);
      }
      if (input.op === 'session') {
        if (input.maxRetries === null) delete draft.sessions[input.sessionId]; else draft.sessions[input.sessionId] = count(input.maxRetries);
      }
    });
    return currentView(input.op === 'session' ? input.sessionId : undefined);
  }
  ctx.inject(['connection'], child => child.connection.fetch.register({
    path: route, methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (disposed) return response(503, {error: '插件正在重新加载'});
        if (request.method === 'GET') {
          const url = new URL(request.url);
          if (url.searchParams.get('catalog') === '1') {
            const catalog = [];
            for (const provider of ctx.llm.listProviders()) {
              try { for (const model of await ctx.llm.listModels(provider.id)) catalog.push({provider: provider.id, providerName: provider.name ?? provider.id, model: model.id, name: model.name ?? model.id}); }
              catch { /* One unavailable provider must not hide other routes or saved rules. */ }
            }
            return response(200, {catalog});
          }
          const rawId = url.searchParams.get('session');
          const id = rawId === null ? undefined : identity.parse(rawId);
          if (url.searchParams.get('errors') === '1') { await collector.drain(); await inbox.prune(); return response(200, errorsView(id)); }
          return response(200, currentView(id));
        }
        let body;
        try { body = await request.json(); } catch { return response(400, {error: '请求必须是有效 JSON'}); }
        const input = mutation.parse(body);
        const operation = mutate(input);
        running.add(operation);
        try { return response(200, await operation); } finally { running.delete(operation); }
      } catch (error) {
        return response(error instanceof z.ZodError ? 400 : error.status ?? 500, {error: error instanceof z.ZodError ? '请求参数无效：请检查范围、错误规则、次数（0–100）与间隔（0.1–3600 秒）' : error.message});
      }
    }
  }));
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.allSettled([...running]);
    await collector.drain();
    await store.drain();
  }, 'retry-manager: drain configuration writes');
  ctx.logger.info('Retry Manager ready: model defaults and per-session overrides (official executor).');
}
