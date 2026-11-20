import { z } from 'zod';
import { normalizeRetryFailure } from './policy.js';

export const NEVER_OVERRIDE = new Set(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED']);
const restricted = /auth|credential|unauthori[sz]ed|forbidden|api.?key|quota|billing|balance|余额|配额|密钥|认证|权限/i;
export function needsRiskConfirmation(error) {
  return error.status === 401 || error.status === 403 || restricted.test(error.code + ' ' + error.message)
    || ['INVALID_REQUEST', 'MALFORMED_RESPONSE', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MISSING_CREDENTIAL'].includes(error.code);
}
export const errorSignatureSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().min(1).max(160),
  status: z.number().int().min(100).max(599).optional(), message: z.string().min(1).max(4096)
}).strict();
export const errorRuleSchema = z.object({
  id: z.string().uuid(), scope: z.enum(['session', 'model', 'global']), target: z.string().max(600),
  action: z.enum(['keep', 'allow', 'deny']), error: errorSignatureSchema,
  confirmedRisk: z.boolean(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative()
}).strict().refine(rule => (!NEVER_OVERRIDE.has(rule.error.code) || rule.action==='keep')
  && (rule.action!=='allow' || (!(needsRiskConfirmation(rule.error) || rule.scope==='global') || rule.confirmedRisk)), '风险错误需明确确认；取消和专属恢复错误不可强制重试');
export function ruleTarget(scope, sessionId, provider, model) {
  return scope === 'global' ? '*' : scope === 'session' ? sessionId : JSON.stringify([provider, model]);
}
export function matchedRule(rules, error, sessionId, provider, model) {
  for (const scope of ['session', 'model', 'global']) {
    const target = ruleTarget(scope, sessionId, provider, model);
    const rule = (rules ?? []).find(rule => rule.scope === scope && rule.target === target && rule.error.fingerprint === error.fingerprint);
    if (rule) return rule;
  }
}
export function decideFailure(rules, error, sessionId, provider, model, failure, basePolicy, hasProviderPolicy = true) {
  const rule = matchedRule(rules, error, sessionId, provider, model);
  const normal = normalizeRetryFailure(failure);
  const hardStop = NEVER_OVERRIDE.has(failure.code);
  const baseRetryable = !hardStop && hasProviderPolicy && basePolicy.retryableCodes.includes(normal.code);
  const retryable = !hardStop && hasProviderPolicy && (rule?.action === 'allow' || rule?.action !== 'deny' && baseRetryable);
  return {ruleId: rule?.id ?? null, action: rule?.action ?? 'keep', source: rule?.scope ?? 'original',
    baseRetryable, retryable, canOverride: !hardStop && hasProviderPolicy, maxRetries: basePolicy.maxRetries,
    failure: rule?.action === 'allow' ? failure : normal};
}
export function executionPolicy(policy, rules) {
  // One stable key for the entire failed step, including failures with DIFFERENT codes.
  const codes = [...new Set([...policy.retryableCodes, ...(rules ?? []).filter(rule => rule.action === 'allow').map(rule => rule.error.code)])];
  return Object.freeze({...policy, retryableCodes: Object.freeze(codes)});
}
