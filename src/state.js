import { readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import { MAX_RETRIES } from './policy.js';
const retries = z.number().int().min(0).max(MAX_RETRIES);
const schema = z.object({version: z.literal(1), revision: z.number().int().nonnegative(), defaultMaxRetries: retries.nullable(), models: z.record(z.string(), retries), sessions: z.record(z.string(), retries)}).strict();
const empty = () => ({version: 1, revision: 0, defaultMaxRetries: null, models: {}, sessions: {}});
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
