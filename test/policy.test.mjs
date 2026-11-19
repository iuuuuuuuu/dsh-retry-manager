import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePolicy,modelKey,count} from '../src/policy.js';
const base={version:1,revision:0,defaultMaxRetries:null,models:{},sessions:{}};
const provider={mode:'normal',maxRetries:5,retryableCodes:['SERVER','AUTH','ABORTED'],initialDelayMs:10,maxDelayMs:100,jitterRatio:0};
test('precedence: session > provider/model pair > global > provider',()=>{
 const state=structuredClone(base);state.defaultMaxRetries=4;state.models[modelKey('p','m')]=3;state.sessions.s=0;
 assert.equal(effectivePolicy(state,'s','p','m',provider).policy.maxRetries,0);
 assert.equal(effectivePolicy(state,'other','p','m',provider).policy.maxRetries,3);
 assert.equal(effectivePolicy(state,'other','other-provider','m',provider).policy.maxRetries,4);
 assert.equal(effectivePolicy(base,'s','p','m',provider).policy.maxRetries,5);
});
test('always mode is bounded and permanent errors are filtered',()=>{
 const result=effectivePolicy(base,'s','p','m',{...provider,mode:'always'});assert.equal(result.policy.mode,'normal');assert.equal(result.policy.maxRetries,5);
 assert.deepEqual(effectivePolicy(base,'s','p','m',provider).policy.retryableCodes,['SERVER']);
});
test('reject invalid counts rather than silently rounding',()=>{for(const value of [-1,101,0.5,'3',NaN])assert.throws(()=>count(value));assert.equal(count(0),0);assert.equal(count(100),100)});

test('global fixed interval applies independently of count precedence',()=>{
 const state={...structuredClone(base),retryIntervalMs:1500};state.models[modelKey('p','m')]=100;state.sessions.s=80;
 const policy=effectivePolicy(state,'s','p','m',provider).policy;
 assert.equal(policy.maxRetries,80);assert.equal(policy.initialDelayMs,1500);assert.equal(policy.maxDelayMs,1500);assert.equal(policy.jitterRatio,0);
 const inherited=effectivePolicy({...state,retryIntervalMs:null},'s','p','m',provider).policy;
 assert.equal(inherited.initialDelayMs,10);assert.equal(inherited.maxDelayMs,100);
 assert.equal(effectivePolicy(base,'s','p','m',{...provider,maxRetries:200}).policy.maxRetries,100);
});
