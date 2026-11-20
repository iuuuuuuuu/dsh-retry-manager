import { effectivePolicy } from './policy.js';
import { errorSignature } from './errors.js';
import { decideFailure, executionPolicy, NEVER_OVERRIDE } from './rules.js';

// The official executor alone owns retry IDs, budgets, persistence and backoff.
// Capture one policy AND rule set for a failed step; edits affect the NEXT step.
export async function installExecutor(ctx, store, officialApply, collector) {
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
          if (typeof model !== 'string') return next();
          let captured = steps.get(session);
          if (!captured || captured.turn !== payload.turn || captured.step !== payload.step) {
            const snapshot = store.snapshot();
            const resolved = effectivePolicy(snapshot, session.id, payload.provider, model, payload.retryPolicy);
            const rules = snapshot.errorRules ?? [];
            captured = {turn:payload.turn, step:payload.step, policy:resolved.policy, rules, execution:executionPolicy(resolved.policy, rules)};
            steps.set(session, captured);
          }
          const decision = decideFailure(captured.rules, errorSignature(payload.failure), session.id, payload.provider, model,
            payload.failure, captured.policy, payload.retryPolicy !== undefined);
          collector?.recover(payload, decision);
          if (NEVER_OVERRIDE.has(payload.failure.code)) return next();
          if (decision.action === 'deny') return;
          if (!decision.retryable) return next();
          return listener({...payload, failure:decision.failure, retryPolicy:captured.execution}, next);
        }, options);
      };
    }
  });
  await officialApply(adapter, {});
}
