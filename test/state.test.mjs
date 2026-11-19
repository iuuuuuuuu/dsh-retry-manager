import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';import{createStore}from'../src/state.js';
test('atomic persistence, revision conflicts and corrupt input',async()=>{
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-state-'));try{
 const file=join(dir,'state.json');const state=await createStore(file);assert.equal(state.snapshot().revision,0);
 await state.update(0,s=>{s.defaultMaxRetries=3;s.sessions.example=0});assert.equal((await createStore(file)).snapshot().sessions.example,0);
 await assert.rejects(state.update(0,s=>s.defaultMaxRetries=9),/其他窗口/);
 await assert.rejects(state.update(1,s=>s.defaultMaxRetries=99));assert.equal(state.snapshot().revision,1);
 const racing=await Promise.allSettled([state.update(1,s=>s.defaultMaxRetries=2),state.update(1,s=>s.defaultMaxRetries=4)]);assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(JSON.parse(await readFile(file,'utf8')).revision,2);
 await writeFile(file,'invalid');await assert.rejects(createStore(file),/读取失败/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
