import { effectivePolicy, normalizeRetryFailure } from './policy.js';

// The official executor alone owns retry IDs, budgets, persistence and backoff.
// Capture one policy for a failed step; edits during backoff affect the NEXT step.
export async function installExecutor(ctx, store, officialApply) {
  const steps = new WeakMap();
  const adapter = new Proxy(ctx, {
    get(target, key) {
      if (key !== 'on') return Reflect.get(target, key, target);
      return (event, listener, options) => {
        if (event !== 'agent/request-error') return target.on(event, listener, options);
        return target.on(event, (payload, next) => {
          if (payload.signal.aborted) return;
          const session = payload.agent.session;
          const model = session.requestHeader()?.config?.model;
          if (typeof model !== 'string' || payload.retryPolicy === undefined) return next();
          let captured = steps.get(session);
          if (!captured || captured.turn !== payload.turn || captured.step !== payload.step) {
            const resolved = effectivePolicy(store.snapshot(), session.id, payload.provider, model, payload.retryPolicy);
            captured = {turn: payload.turn, step: payload.step, policy: resolved.policy};
            steps.set(session, captured);
          }
          return listener({...payload, failure: normalizeRetryFailure(payload.failure), retryPolicy: captured.policy}, next);
        }, options);
      };
    }
  });
  await officialApply(adapter, {});
}
