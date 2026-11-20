import { errorSignature, groupId } from './errors.js';

// Only terminal model failure facts are read. Text/reasoning/tool deltas are never retained.
export function attemptFailure(event) {
  if (event.type !== 'assistant/attempt') return;
  for (const record of [...event.data.stream ?? []].reverse()) {
    const chunk = record.type === 'chunk' ? record.chunk : undefined;
    if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return chunk.reason.failure;
  }
}
export function createCollector(ctx, inbox) {
  const live = new WeakMap();
  let error = null;
  const pending = new Set();
  const write = value => {
    const task = inbox.record(value).catch(() => { error = '错误收件箱写入失败；重试策略未改变，请检查存储权限后重新加载插件。'; })
      .finally(() => pending.delete(task));
    pending.add(task);
    return task;
  };
  function remember(session, event, route, previous) {
    const data = event.data;
    const failure = attemptFailure(event);
    if (failure) {
      const signature = errorSignature(failure);
      const value = {id:session.id+':'+event.seq, groupId:groupId(route?.provider ?? '', route?.model ?? '', signature.fingerprint),
        sessionId:session.id, provider:route?.provider ?? '', model:route?.model ?? '', turn:data.turn, step:data.step,
        seq:event.seq, time:event.time, error:signature, boundary:true, outcome:'observed'};
      write(value); return value;
    }
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
      if (previous?.turn === data.turn && previous.step === data.step) {
        const value = {...previous, outcome:event.type === 'llm/retry' ? 'scheduled' : 'retrying'};
        write(value); return value;
      }
    }
    if (event.type === 'turn/end' && data.reason?.kind === 'error') {
      const signature = errorSignature(data.reason.error);
      if (previous?.turn === data.turn && previous.error.fingerprint === signature.fingerprint) {
        const value = {...previous, outcome:'terminal'}; write(value); return value;
      }
      // Preparation/middleware errors do not necessarily cross the request recovery hook.
      const value = {id:session.id+':'+event.seq, groupId:groupId(route?.provider ?? '', route?.model ?? '', signature.fingerprint),
        sessionId:session.id, provider:route?.provider ?? '', model:route?.model ?? '', turn:data.turn, step:previous?.turn === data.turn ? previous.step : 0,
        seq:event.seq, time:event.time, error:signature, boundary:false, outcome:'terminal'};
      write(value); return value;
    }
    return previous;
  }
  return {
    observe(session, event) {
      if (event.type === 'step/start' || event.type === 'turn/start') { live.delete(session); return; }
      if (!['assistant/attempt', 'llm/retry', 'llm/retry-started', 'turn/end'].includes(event.type)) return;
      const route = session.requestHeader()?.config;
      const value = remember(session, event, route, live.get(session));
      if (value) live.set(session, value);
    },
    recover(payload, decision) {
      const session = payload.agent.session;
      const value = live.get(session);
      if (!value || value.turn !== payload.turn || value.step !== payload.step) return;
      const {failure: ignored, ...facts} = decision;
      const next = {...value, decision:facts};
      live.set(session, next); write(next);
    },
    async sync(sessionId) {
      const query = ctx.get('sessionQuery');
      if (!query) throw new Error('当前宿主没有被动会话读取能力；仍会自动收集新错误。');
      const observation = await query.observeSession(sessionId, {projectionMode:'none'});
      try {
        const session = {id:sessionId}; let route, previous;
        const start = Math.max(observation.inheritedEventCount, observation.events.length-2000);
        for (const event of observation.events) {
          if (event.type === 'request/header') route = event.data.header.config;
          if (event.type === 'step/start' || event.type === 'turn/start') previous = undefined;
          if (event.seq < start) continue;
          previous = remember(session, event, route, previous);
        }
      } finally { observation[Symbol.dispose](); }
      await this.drain();
    },
    status: () => error,
    async drain() { await Promise.allSettled([...pending]); await inbox.drain(); }
  };
}
