import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { errorRuleSchema } from './rules.js';
import { MAX_RETRIES, MIN_RETRY_INTERVAL_MS, MAX_RETRY_INTERVAL_MS } from './policy.js';
const retries = z.number().int().min(0).max(MAX_RETRIES);
const schema = z.object({version: z.literal(1), revision: z.number().int().nonnegative(), defaultMaxRetries: retries.nullable(), retryIntervalMs: z.number().int().min(MIN_RETRY_INTERVAL_MS).max(MAX_RETRY_INTERVAL_MS).multipleOf(100).nullable().default(null), models: z.record(z.string(), retries), sessions: z.record(z.string(), retries), errorRules: z.array(errorRuleSchema).max(500).default([])}).strict();
const empty = () => ({version: 1, revision: 0, defaultMaxRetries: null, retryIntervalMs: null, models: {}, sessions: {}, errorRules: []});
export async function createStore(file) {
  let state;
  try { state = schema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('重试配置读取失败，请修复配置后重新加载插件', { cause: error }); state = empty(); }
  let queue = Promise.resolve();
  return {
    snapshot: () => structuredClone(state),
    update(expectedRevision, change) {
      const operation = queue.then(async () => {
        if (expectedRevision !== state.revision) { const e = new Error('配置已被其他窗口修改，请刷新后重试'); e.status = 409; throw e; }
        const draft = structuredClone(state);
        change(draft);
        draft.revision += 1;
        const next = schema.parse(draft);
        await mkdir(dirname(file), { recursive: true });
        await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        state = next;
        return structuredClone(state);
      });
      queue = operation.catch(() => {});
      return operation;
    },
    drain: () => queue
  };
}
