export const MAX_RETRIES = 20;
export const TRANSIENT_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
export const BLOCKED_CODES = new Set(['ABORTED', 'AUTH', 'AUTHENTICATION', 'UNAUTHORIZED', 'FORBIDDEN', 'MISSING_CREDENTIAL', 'QUOTA', 'INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'IMAGE_OFFLOAD_REQUIRED', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MALFORMED_RESPONSE']);
export function count(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETRIES) throw new TypeError('重试次数必须是 0–20 的整数');
  return value;
}
export const modelKey = (provider, model) => JSON.stringify([provider, model]);
export function effectivePolicy(state, sessionId, provider, model, inherited) {
  const session = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : undefined;
  const key = modelKey(provider, model);
  const modelRule = Object.hasOwn(state.models, key) ? state.models[key] : undefined;
  const selected = session !== undefined ? { source: 'session', maxRetries: session }
    : modelRule !== undefined ? { source: 'model', maxRetries: modelRule }
    : state.defaultMaxRetries !== null ? { source: 'default', maxRetries: state.defaultMaxRetries }
    : { source: 'provider', maxRetries: inherited?.mode === 'normal' ? Math.min(inherited.maxRetries, MAX_RETRIES) : 5 };
  const eligible = inherited?.mode === 'normal' ? inherited.retryableCodes : TRANSIENT_CODES;
  return { source: selected.source, policy: Object.freeze({
    mode: 'normal', maxRetries: selected.maxRetries,
    retryableCodes: Object.freeze(eligible.filter(code => !BLOCKED_CODES.has(code))),
    initialDelayMs: inherited?.initialDelayMs ?? 500,
    maxDelayMs: inherited?.maxDelayMs ?? 10000,
    jitterRatio: inherited?.jitterRatio ?? 0.1
  }) };
}
