import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import redact from 'fast-redact';
import { z } from 'zod';
import { errorSignatureSchema, matchedRule } from './rules.js';

export const MAX_ERROR_EVENTS = 1000;
export const ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const secretField = /(?:authorization|cookie|api[-_]?key|token|password|secret|credential|signature|client[-_]?key)|^(?:headers|prompt|messages|input|output|body|request|response)$/i;
const censor = redact({paths: ['secret'], serialize: false, censor: '[已脱敏]'});
function scrubObject(value, depth = 0) {
  if (depth > 12) return '[层级已截断]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => scrubObject(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) =>
    [key, /^(?:request[-_]?id|trace[-_]?id)$/i.test(key) ? '[请求标识]' : secretField.test(key) ? censor({secret: item}).secret : scrubObject(item, depth + 1)]));
  return typeof value === 'string' ? scrubText(value) : value;
}
export function scrubText(value) {
  return String(value).replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[认证已脱敏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[密钥已脱敏]')
    .replace(/((?:["']?(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret|cookie|token|prompt|messages|headers|body|request|response|密钥)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[已脱敏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, match => {
      try { const url = new URL(match); return url.origin + (url.pathname === '/' ? '/' : '/[路径已省略]') + (url.search ? '?[参数已脱敏]' : ''); }
      catch { return '[地址已脱敏]'; }
    });
}
export function errorSignature(failure) {
  let raw = String(failure.message ?? '未提供错误信息').slice(0, 65536);
  // Providers often prefix JSON with an HTTP status. Parse and redact structured fields before displaying text.
  const start = raw.indexOf('{');
  if (start >= 0) {
    try { raw = scrubText(raw.slice(0, start)) + JSON.stringify(scrubObject(JSON.parse(raw.slice(start)))); }
    catch { raw = scrubText(raw); }
  } else raw = scrubText(raw);
  const normalized = raw.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[请求标识]')
    .replace(/\b(?:request[_ -]?id|trace[_ -]?id)\s*[:=]\s*[A-Za-z0-9_-]+/gi, 'request-id=[标识]')
    .replace(/\s+/g, ' ').trim() || '未提供错误信息';
  const code = scrubText(failure.code ?? 'UNKNOWN').slice(0, 160) || 'UNKNOWN';
  const statusMatch = /^\s*([45]\d\d)\b/.exec(normalized) ?? /^[^\n]{0,180}\bAPI error \(([45]\d\d)\):/.exec(normalized);
  const status = Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599 ? failure.status
    : Number(statusMatch?.[1]) || undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify([code, status ?? null, normalized])).digest('hex');
  return {fingerprint, code, ...status === undefined ? {} : {status}, message: normalized.slice(0, 4096)};
}
export const groupId = (provider, model, fingerprint) => createHash('sha256').update(JSON.stringify([provider, model, fingerprint])).digest('hex');
const decisionSchema = z.object({ruleId: z.string().nullable(), action: z.enum(['keep', 'allow', 'deny']), source: z.enum(['original', 'session', 'model', 'global']),
  baseRetryable: z.boolean(), retryable: z.boolean(), canOverride: z.boolean(), maxRetries: z.number().int().min(0).max(100)}).strict();
const outcomeRank = {observed:0, scheduled:1, retrying:2, terminal:3};
const entrySchema = z.object({
  id: z.string().min(1).max(400), groupId: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string().min(1).max(240),
  provider: z.string().max(240), model: z.string().max(240), turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(), time: z.number().int().nonnegative(), error: errorSignatureSchema,
  boundary: z.boolean(), outcome: z.enum(['observed', 'scheduled', 'retrying', 'terminal']), decision: decisionSchema.optional()
}).strict();
export const MAX_IGNORED_FAMILIES = 500;
const ignoredSchema = z.object({key:z.string().min(1).max(1200), ignoredAt:z.number().int().nonnegative(), sample:entrySchema}).strict();
const schema = z.object({version:z.literal(1), revision:z.number().int().nonnegative(),
  visibilityRevision:z.number().int().nonnegative().default(0),
  entries:z.array(entrySchema).max(MAX_ERROR_EVENTS), ignored:z.array(ignoredSchema).max(MAX_IGNORED_FAMILIES).default([])}).strict();
export async function createInbox(file) {
  let state;
  try { state = schema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('错误收件箱读取失败，请修复 errors.json 后重载插件', {cause:error}); state = {version:1, revision:0, visibilityRevision:0, entries:[], ignored:[]}; }
  let queue = Promise.resolve();
  async function prune() {
    const operation = queue.then(async () => {
      const entries = state.entries.filter(entry => entry.time >= Date.now()-ERROR_RETENTION_MS);
      if (entries.length === state.entries.length) return;
      const next = {...state, revision:state.revision+1, entries};
      await mkdir(dirname(file), {recursive:true});
      await writeFileAtomic(file, JSON.stringify(next, null, 2)+'\n', {mode:0o600});
      state = next;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  await prune();
  return {
    prune,
    setIgnored(expectedRevision, key, sample) {
      const operation = queue.then(async () => {
        if (expectedRevision !== state.visibilityRevision) { const e=new Error('收件箱显示设置已被其他窗口修改，请刷新后重试');e.status=409;throw e; }
        const next=structuredClone(state), previous=next.ignored.find(item=>item.key===key);
        if (!sample && !previous) { const e=new Error('该类错误已恢复显示，请刷新');e.status=409;throw e; }
        next.ignored=next.ignored.filter(item=>item.key!==key);
        if (sample) {
          if (errorFamilyKey(sample.provider,sample.model,sample.error)!==key) throw new Error('忽略特征不匹配');
          if (next.ignored.length>=MAX_IGNORED_FAMILIES) { const e=new Error('最多忽略 500 类错误，请先恢复部分忽略项');e.status=400;throw e; }
          const latest=next.entries.filter(entry=>errorFamilyKey(entry.provider,entry.model,entry.error)===key)
            .sort((a,b)=>b.time-a.time||b.seq-a.seq)[0];
          next.ignored.push({key,ignoredAt:previous?.ignoredAt??Date.now(),sample:latest&&latest.time>=sample.time?latest:sample});
        }
        next.visibilityRevision+=1;next.revision+=1;
        const parsed=schema.parse(next);
        await mkdir(dirname(file),{recursive:true});
        await writeFileAtomic(file,JSON.stringify(parsed,null,2)+'\n',{mode:0o600});state=parsed;
      });
      queue=operation.catch(()=>{});return operation;
    },
    snapshot: () => ({...structuredClone(state), entries:structuredClone(state.entries.filter(entry => entry.time >= Date.now()-ERROR_RETENTION_MS))}),
    record(input) {
      const operation = queue.then(async () => {
        if (input.time < Date.now()-ERROR_RETENTION_MS) return;
        const next = structuredClone(state);
        const index = next.entries.findIndex(entry => entry.id === input.id);
        if (index >= 0) {
          const previous = next.entries[index];
          // History re-reads may enrich observations, never undo live recovery outcomes.
          next.entries[index] = {...previous, ...input, boundary: previous.boundary || input.boundary,
            outcome: outcomeRank[input.outcome] < outcomeRank[previous.outcome] ? previous.outcome : input.outcome, decision: input.decision ?? previous.decision};
          if (JSON.stringify(previous) === JSON.stringify(next.entries[index])) return;
        } else next.entries.push(input);
        const recorded=next.entries.find(entry=>entry.id===input.id);
        const ignored=next.ignored.find(item=>item.key===errorFamilyKey(recorded.provider,recorded.model,recorded.error));
        if (ignored && recorded.time>=ignored.sample.time) ignored.sample=structuredClone(recorded);
        next.entries = next.entries.filter(entry => entry.time >= Date.now() - ERROR_RETENTION_MS).sort((a,b) => b.time-a.time || b.seq-a.seq).slice(0,MAX_ERROR_EVENTS);
        next.revision += 1;
        const parsed = schema.parse(next);
        await mkdir(dirname(file), {recursive:true});
        await writeFileAtomic(file, JSON.stringify(parsed, null, 2)+'\n', {mode:0o600});
        state = parsed;
      });
      queue = operation.catch(() => {});
      return operation;
    },
    drain: () => queue
  };
}
export function errorFamilyKey(provider, model, error) {
  const {code,status,fingerprint}=error;
  return JSON.stringify([provider,model,code,
    status!==undefined||['SERVER','AUTH','TRANSPORT','TIMEOUT','RATE_LIMIT'].includes(code)?status??null:fingerprint]);
}
export function partitionErrorEntries(entries, rules, ignored) {
  const result={pending:[],configured:[],ignored:[]},keys=new Set(ignored.map(item=>item.key));
  for (const entry of entries) {
    const configured=matchedRule(rules,entry.error,entry.sessionId,entry.provider,entry.model);
    const hidden=keys.has(errorFamilyKey(entry.provider,entry.model,entry.error));
    if (configured) result.configured.push(entry);
    else if (!hidden) result.pending.push(entry);
    // Keep ignored families discoverable even after configuring their individual variants.
    if (hidden) result.ignored.push(entry);
  }
  return result;
}
// Display-only families never replace the exact fingerprints used by saved rules.
export function groupErrorFamilies(entries, sessionId) {
  const families = new Map();
  for (const group of groupErrors(entries, sessionId)) {
    const familyKey = errorFamilyKey(group.provider,group.model,group.error);
    let family = families.get(familyKey);
    if (!family) {
      family = {familyKey, provider:group.provider, model:group.model, error:group.error,
        variants:[], count:0, firstSeen:group.firstSeen, lastSeen:group.lastSeen};
      families.set(familyKey, family);
    }
    family.variants.push(group);
    family.count += group.count;
    family.firstSeen = Math.min(family.firstSeen, group.firstSeen);
    family.lastSeen = Math.max(family.lastSeen, group.lastSeen);
  }
  return [...families.values()].map(family => ({...family, id:family.variants[0].id,
    latest:family.variants[0].latest, variantCount:family.variants.length}));
}

export function groupErrors(entries, sessionId) {
  const groups = new Map(), seen = new Set();
  const sorted = [...entries].sort((a,b) => b.time-a.time || b.seq-a.seq);
  for (const entry of sorted) {
    if ((sessionId && entry.sessionId !== sessionId) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    let group = groups.get(entry.groupId);
    if (!group) {
      group = {id:entry.groupId, provider:entry.provider, model:entry.model, error:entry.error,
        count:0, firstSeen:entry.time, lastSeen:entry.time, latest:entry, occurrences:[]};
      groups.set(entry.groupId, group);
    }
    group.count += 1;
    group.firstSeen = Math.min(group.firstSeen, entry.time);
    if (group.occurrences.length < 10) group.occurrences.push(entry);
  }
  return [...groups.values()];
}
