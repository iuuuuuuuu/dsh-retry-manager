import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';import{createStore}from'../src/state.js';
test('atomic persistence, revision conflicts and corrupt input',async()=>{
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-state-'));try{
 const file=join(dir,'state.json');const state=await createStore(file);assert.equal(state.snapshot().revision,0);
 await state.update(0,s=>{s.defaultMaxRetries=3;s.sessions.example=0});assert.equal((await createStore(file)).snapshot().sessions.example,0);
 await assert.rejects(state.update(0,s=>s.defaultMaxRetries=9),/其他窗口/);
 await assert.rejects(state.update(1,s=>s.defaultMaxRetries=101));assert.equal(state.snapshot().revision,1);
 const racing=await Promise.allSettled([state.update(1,s=>s.defaultMaxRetries=2),state.update(1,s=>s.defaultMaxRetries=4)]);assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(JSON.parse(await readFile(file,'utf8')).revision,2);
 await writeFile(file,'invalid');await assert.rejects(createStore(file),/读取失败/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('legacy counts migrate without losing overrides; interval persists independently',async()=>{
 const dir=await mkdtemp(join(process.env.DSH_TEST_ROOT||tmpdir(),'retry-migration-'));try{
 const file=join(dir,'state.json');const legacy={version:1,revision:4,defaultMaxRetries:20,models:{'["p","m"]':7},sessions:{existing:0}};
 await writeFile(file,JSON.stringify(legacy));const state=await createStore(file);
 assert.deepEqual(state.snapshot(),{...legacy,retryIntervalMs:null});
 await state.update(4,s=>{s.defaultMaxRetries=100;s.retryIntervalMs=1500;s.models['["p","m"]']=100;s.sessions.existing=100;});
 const saved=(await createStore(file)).snapshot();assert.equal(saved.defaultMaxRetries,100);assert.equal(saved.retryIntervalMs,1500);assert.equal(saved.sessions.existing,100);
 for(const invalid of [0,99,150,3600001,NaN])await assert.rejects(state.update(5,s=>s.retryIntervalMs=invalid));
 assert.equal(state.snapshot().revision,5);
 await state.update(5,s=>s.retryIntervalMs=null);assert.equal((await createStore(file)).snapshot().retryIntervalMs,null);
 }finally{await rm(dir,{recursive:true,force:true})}
});
