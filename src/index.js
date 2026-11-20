import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
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
  const active = new WeakMap();
  let disposed = false;
  const running = new Set();
  ctx.on('session/event', (session, event) => {
    if (event.type === 'llm/retry') active.set(session, {...event.data, phase: 'waiting', until: event.time + event.data.delayMs});
    else if (event.type === 'llm/retry-started') {
      const current = active.get(session);
      if (current?.retryId === event.data.retryId) active.set(session, {...current, phase: 'retrying'});
    } else if (['step/start', 'step/end', 'turn/end'].includes(event.type)) active.delete(session);
  });
  await installExecutor(ctx, store, await officialExecutor());

  function sessionFor(id) {
    const agent = ctx.agents.get(id);
    if (!agent) { const e = new Error('该对话尚未加载，请打开对话后重试'); e.status = 404; throw e; }
    return agent;
  }
  function currentView(sessionId) {
    const state = store.snapshot();
    const result = {version: '0.1.2', revision: state.revision, defaultMaxRetries: state.defaultMaxRetries, retryIntervalMs: state.retryIntervalMs,
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
  async function mutate(input) {
    if (disposed) throw new Error('插件正在重新加载，请稍后再试');
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
          return response(200, currentView(id));
        }
        let body;
        try { body = await request.json(); } catch { return response(400, {error: '请求必须是有效 JSON'}); }
        const input = mutation.parse(body);
        const operation = mutate(input);
        running.add(operation);
        try { return response(200, await operation); } finally { running.delete(operation); }
      } catch (error) {
        return response(error instanceof z.ZodError ? 400 : error.status ?? 500, {error: error instanceof z.ZodError ? '请求参数无效：次数须为 0–100 的整数，间隔须为 0.1–3600 秒（精确到 0.1 秒）' : error.message});
      }
    }
  }));
  ctx.effect(() => async () => {
    disposed = true;
    await Promise.allSettled([...running]);
    await store.drain();
  }, 'retry-manager: drain configuration writes');
  ctx.logger.info('Retry Manager ready: model defaults and per-session overrides (official executor).');
}
