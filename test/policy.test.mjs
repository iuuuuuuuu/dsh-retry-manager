import test from 'node:test';
import assert from 'node:assert/strict';
import {effectivePolicy,modelKey,count,normalizeRetryFailure} from '../src/policy.js';
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

test('only explicit temporary upstream adapter errors normalize to SERVER without mutating facts',()=>{
 for(const message of ['Upstream service temporarily unavailable','server_error: Upstream service temporarily unavailable','Error Code server_error: Upstream service temporarily unavailable','Upstream request failed, please try again later',' server_error: Upstream service temporarily unavailable. ']){
  const original=Object.freeze({code:'PI_AI_ERROR',message,requestId:'test-request',providerRetryAfterMs:1000});
  const actual=normalizeRetryFailure(original);assert.equal(actual.code,'SERVER');assert.equal(actual.message,message);assert.equal(actual.requestId,original.requestId);assert.equal(actual.providerRetryAfterMs,1000);assert.equal(original.code,'PI_AI_ERROR');assert.equal(Object.isFrozen(actual),true);
 }
});
test('permanent, unknown, pending, malformed and misleading errors remain unchanged',()=>{
 const messages=['An unknown error occurred','pi-ai stream ended pending','pi-ai deferred response is not supported','Invalid API key','Insufficient quota','server_error: Upstream service temporarily unavailable: invalid API key','AUTH: Upstream service temporarily unavailable','Upstream service temporarily unavailable; insufficient_quota','Invalid configuration: Upstream service temporarily unavailable','invalid_request: Upstream service temporarily unavailable','Upstream service unavailable','Some quoted text: Upstream service temporarily unavailable'];
 for(const message of messages){const failure={code:'PI_AI_ERROR',message};assert.equal(normalizeRetryFailure(failure),failure);}
 for(const code of ['AUTH','QUOTA','ABORTED','INVALID_REQUEST','CONTEXT_WINDOW_EXCEEDED','MALFORMED_RESPONSE','UNKNOWN','SERVER']){const failure={code,message:'Upstream service temporarily unavailable'};assert.equal(normalizeRetryFailure(failure),failure);}
 for(const status of [400,401,403,429,NaN,200]){const failure={code:'PI_AI_ERROR',message:'Upstream service temporarily unavailable',status};assert.equal(normalizeRetryFailure(failure),failure);}
 const server={code:'PI_AI_ERROR',message:'Upstream service temporarily unavailable',status:503};assert.equal(normalizeRetryFailure(server).code,'SERVER');
});
