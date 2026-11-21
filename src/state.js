import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';
import {initializeStore,readStoreFile,withStorageLock} from './storage.js';
import { errorRuleSchema } from './rules.js';
import { MAX_RETRIES, MIN_RETRY_INTERVAL_MS, MAX_RETRY_INTERVAL_MS } from './policy.js';
const retries = z.number().int().min(0).max(MAX_RETRIES);
const schema = z.object({version: z.literal(1), revision: z.number().int().nonnegative(), defaultMaxRetries: retries.nullable(), retryIntervalMs: z.number().int().min(MIN_RETRY_INTERVAL_MS).max(MAX_RETRY_INTERVAL_MS).multipleOf(100).nullable().default(null), models: z.record(z.string(), retries), sessions: z.record(z.string(), retries), errorRules: z.array(errorRuleSchema).max(500).default([])}).strict();
const empty = () => ({version: 1, revision: 0, defaultMaxRetries: null, retryIntervalMs: null, models: {}, sessions: {}, errorRules: []});
export async function createStore(file,{legacyFile}={}) {
  let loaded=await initializeStore(file,legacyFile,schema,'重试配置',empty);
  let state=loaded.state,persisted=loaded.persisted,queue=Promise.resolve();
  async function reload() {
    loaded=await readStoreFile(file,schema,'重试配置',empty,!persisted);
    state=loaded.state;persisted=loaded.persisted;
  }
  function enqueue(operation) {
    const pending=queue.then(operation);queue=pending.catch(()=>{});return pending;
  }
  return {
    snapshot:()=>structuredClone(state),
    refresh:()=>enqueue(reload),
    update(expectedRevision,change) {
      return enqueue(()=>withStorageLock(file,async()=>{
        await reload();
        if(expectedRevision!==state.revision){const e=new Error('配置已被其他窗口修改，请刷新后重试');e.status=409;throw e;}
        const draft=structuredClone(state);change(draft);draft.revision+=1;
        const next=schema.parse(draft);
        await writeFileAtomic(file,JSON.stringify(next,null,2)+'\n',{mode:0o600});
        state=next;persisted=true;return structuredClone(state);
      }));
    },
    drain:()=>queue
  };
}
