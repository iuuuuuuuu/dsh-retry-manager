const React = require('react');
const { createPortal } = require('react-dom');
const h = React.createElement;
const { useState, useEffect, useCallback, useRef } = React;
const API = new URL('api/dsh-retry-manager', document.baseURI).pathname;
const SOURCE = {session: '本对话', model: '模型默认', default: '全局默认', provider: '提供商默认'};
const CSS = ".drm-panel{font-family:inherit;font-size:13px;line-height:1.6;color:var(--text-primary,#dbe1e8);box-sizing:border-box}.drm-panel *{box-sizing:border-box}.drm-panel h2{font-size:18px;line-height:1.4;margin:0 0 6px;font-weight:650}.drm-panel h3{font-size:14px;margin:0 0 4px;font-weight:600}.drm-panel p{margin:6px 0 12px}.drm-heading,.drm-row,.drm-rule{display:flex;align-items:center;justify-content:space-between;gap:16px}.drm-heading{align-items:flex-start;margin-bottom:20px}.drm-muted,.drm-foot,.drm-model small{color:var(--text-secondary,#929baa)}.drm-foot{font-size:12px;margin-top:20px!important}.drm-tag{font-size:11px;border:1px solid var(--border-color,#38414e);padding:3px 8px;border-radius:20px;white-space:nowrap}.drm-note{padding:12px 14px;background:var(--bg-hover,rgba(120,135,160,.1));border:1px solid var(--border-color,#38414e);border-radius:8px;margin:14px 0 18px}.drm-card{border:1px solid var(--border-color,#38414e);padding:18px;border-radius:10px;margin:16px 0}.drm-panel button,.drm-panel select,.drm-panel input{font:inherit;color:inherit;background:var(--bg-primary,#202630);border:1px solid var(--border-color,#46505e);border-radius:6px;min-height:34px;padding:5px 10px;max-width:100%}.drm-panel button{cursor:pointer;white-space:nowrap}.drm-panel button:hover{background:var(--bg-hover,#303a47)}.drm-panel button:disabled,.drm-panel select:disabled{opacity:.55;cursor:wait}.drm-panel input:focus-visible,.drm-panel select:focus-visible,.drm-panel button:focus-visible{outline:2px solid #739bfa;outline-offset:2px}.drm-panel select{min-width:130px}.drm-card>.drm-row{flex-wrap:wrap}.drm-card>.drm-row>div{flex:1 1 200px}.drm-card>.drm-row>select{flex:1 1 260px;width:100%}.drm-primary{background:#4169cf!important;color:#fff!important;border-color:#587ad7!important}.drm-add{display:grid;grid-template-columns:minmax(130px,1fr) minmax(140px,1.3fr) 100px auto;align-items:end;gap:10px;border-top:1px solid var(--border-color,#38414e);padding-top:16px;margin-top:16px}.drm-add label{display:flex;flex-direction:column;gap:6px;font-size:12px}.drm-add input{width:100%}.drm-rule{padding:10px 0;border-bottom:1px solid var(--border-color,#38414e)}.drm-rule:last-child{border-bottom:0}.drm-model{min-width:0;overflow-wrap:anywhere}.drm-model strong,.drm-model small{display:block}.drm-model small{font-size:12px}.drm-empty{padding:12px 0;color:var(--text-secondary,#929baa)}.drm-error{color:#f69494;background:rgba(190,60,60,.1);padding:10px;border-radius:6px}.drm-trigger{font-family:inherit;font-size:12px;line-height:1.4;background:transparent;color:inherit;border:1px solid var(--border-color,rgba(140,150,165,.35));border-radius:6px;padding:4px 8px;cursor:pointer;white-space:nowrap;opacity:.85}.drm-trigger:hover{opacity:1;background:rgba(130,140,160,.12)}.drm-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.48);z-index:10000;display:flex;justify-content:center;align-items:center;padding:20px}.drm-dialog{background:var(--bg-primary,#1d232c);border:1px solid var(--border-color,#38414e);border-radius:12px;padding:24px;width:490px;max-width:100%;max-height:90vh;overflow:auto;box-shadow:0 18px 70px rgba(0,0,0,.3)}@media(max-width:800px){.drm-add{grid-template-columns:1fr 1fr}.drm-row{flex-wrap:wrap}.drm-card{padding:14px}}@media(prefers-color-scheme:light){.drm-panel{color:var(--text-primary,#283141)}.drm-panel button,.drm-panel select,.drm-panel input{background:var(--bg-primary,#fff);border-color:var(--border-color,#d6dbe3)}.drm-dialog{background:var(--bg-primary,#fff)}.drm-note{background:var(--bg-hover,#f1f4f9)}.drm-card,.drm-rule,.drm-tag,.drm-add{border-color:var(--border-color,#d6dbe3)}}";

async function api(query = '', body, signal) {
  const res = await fetch(API + query, {method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? {'content-type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, signal});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败（' + res.status + '）');
  return data;
}
function useData(sessionId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = sessionId ? '?session=' + encodeURIComponent(sessionId) : '';
  const refresh = useCallback(async (signal) => {
    try { const next = await api(query, undefined, signal); setData(next); setError(''); return next; }
    catch (e) { if (e.name !== 'AbortError') setError(e.message); }
  }, [query]);
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError(''); refresh(abort.signal);
    const timer = sessionId ? setInterval(() => { if (document.visibilityState !== 'hidden') refresh(abort.signal); }, 1500) : null;
    return () => { abort.abort(); if (timer) clearInterval(timer); };
  }, [refresh, sessionId]);
  const save = async body => {
    setBusy(true); setError('');
    try { await api('', body.op === 'cancel' ? body : {...body, revision: data?.revision}); await refresh(); return true; }
    catch (e) { setError(e.message); return false; }
    finally { setBusy(false); }
  };
  return {data, error, busy, save, refresh};
}
function ErrorText({text}) { return text ? h('p', {className: 'drm-error', role: 'alert'}, text) : null; }
function RetrySelect({value, onChange, disabled, label, inherit = '继承上级设置'}) {
  return h('select', {'aria-label': label, value: value === null ? 'inherit' : String(value), disabled,
    onChange: e => onChange(e.target.value === 'inherit' ? null : Number(e.target.value))},
    h('option', {value: 'inherit'}, inherit),
    ...Array.from({length: 21}, (_, n) => h('option', {key: n, value: n}, n === 0 ? '关闭重试（0 次）' : n + ' 次重试')));
}
function BusyLabel({busy}) { return busy ? h('span', {className:'drm-muted', role:'status'}, '正在保存…') : null; }
function SettingsCard() {
  const {data, error, busy, save, refresh} = useData();
  const [catalog, setCatalog] = useState([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [amount, setAmount] = useState(3);
  const [catalogError, setCatalogError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    api('?catalog=1', undefined, abort.signal).then(x => setCatalog(x.catalog)).catch(e => { if(e.name !== 'AbortError') setCatalogError(e.message); });
    return () => abort.abort();
  }, []);
  const providers = [...new Set(catalog.map(x => x.provider))];
  return h('section', {className: 'drm-panel', 'data-testid': 'retry-settings'},
    h('div', {className:'drm-heading'}, h('div', null, h('h2', null, '模型请求重试'), h('p', {className:'drm-muted'}, '网络中断时自动重试失败步骤，不重放已执行的工具。')), h('span', {className:'drm-tag'}, 'Retry Manager')),
    h('div', {className:'drm-note'}, '优先级：当前对话 ＞ 模型 ＞ 全局 ＞ 提供商。设置 3 次，表示首次失败后最多再请求 3 次；每个新步骤重新计数。'),
    h(ErrorText, {text:error}),
    !data ? h('p', {role:'status'}, '正在读取配置…') : h(React.Fragment, null,
      h('div', {className:'drm-card'}, h('div', {className:'drm-row'}, h('div', null, h('h3',null,'全局默认'), h('p',{className:'drm-muted'},'仅在没有模型规则和对话覆盖时使用。')),
        h(RetrySelect, {label:'全局重试次数',value:data.defaultMaxRetries, disabled:busy,onChange:maxRetries=>save({op:'default',maxRetries}), inherit:'继承提供商（默认 5 次，上限 20 次）'}))),
      h('div', {className:'drm-card'}, h('h3',null,'按模型设置'), h('p',{className:'drm-muted'},'模型用“提供商 + 模型 ID”识别，同名模型不会串用设置。'),
        data.models.length === 0 ? h('p',{className:'drm-empty'},'尚未添加模型规则，当前继承上级设置。') : h('div',{className:'drm-rules'},...data.models.map(rule=>h('div',{className:'drm-rule',key:JSON.stringify([rule.provider,rule.model])},
          h('div',{className:'drm-model'},h('strong',null,rule.model),h('small',null,rule.provider)),
          h(RetrySelect,{label:rule.provider+'/'+rule.model+' 重试次数',value:rule.maxRetries, disabled:busy,onChange:maxRetries=>save({op:'model',provider:rule.provider,model:rule.model,maxRetries}),inherit:'移除规则，继承上级'})))),
        h('form',{className:'drm-add',onSubmit:async e=>{e.preventDefault(); if(await save({op:'model',provider:provider.trim(),model:model.trim(),maxRetries:amount})){setModel('');}}},
          h('label',null,'提供商 ID',h('input',{'aria-label':'提供商 ID',value:provider,list:'drm-providers',required:true,maxLength:240,placeholder:'例如 my-gateway',onChange:e=>{setProvider(e.target.value);setModel('');}})),
          h('datalist',{id:'drm-providers'},...providers.map(id=>h('option',{value:id,key:id}))),
          h('label',null,'模型 ID',h('input',{'aria-label':'模型 ID',value:model,list:'drm-models',required:true,maxLength:240,placeholder:'选择或输入模型 ID',onChange:e=>setModel(e.target.value)})),
          h('datalist',{id:'drm-models'},...catalog.filter(x=>x.provider===provider).map(x=>h('option',{value:x.model,key:x.model},x.name))),
          h('label',null,'重试次数',h('input',{type:'number','aria-label':'新增模型重试次数',min:0,max:20,step:1,required:true,value:amount,onChange:e=>setAmount(Number(e.target.value))})),
          h('button',{className:'drm-primary',type:'submit',disabled:busy},'保存模型规则')),
        catalogError ? h('p',{className:'drm-muted'},'模型目录暂不可用，可手动填写 ID。'+catalogError) : null),
      h('div',{className:'drm-row'},h(BusyLabel,{busy}),h('button',{type:'button',onClick:()=>refresh(),disabled:busy},'刷新配置'))),
    h('p',{className:'drm-foot'},'只对可恢复的模型请求错误重试。手动停止、认证／配额／参数错误不重试；上下文溢出仍由 DSH 压缩处理。配置在当前失败步骤结束后生效。每次重试可能产生模型费用。'));
}
function SessionControl({sessionId}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef(null);
  const {data,error,busy,save,refresh} = useData(sessionId);
  const session = data?.session;
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement;
    const focusable=()=>Array.from(dialogRef.current?.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex="0"]')||[]);
    focusable()[0]?.focus();
    const listener=e=>{
      if(e.key==='Escape'){e.preventDefault();setOpen(false);}
      if(e.key==='Tab'){const list=focusable(),first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    document.addEventListener('keydown',listener);
    return()=>{document.removeEventListener('keydown',listener);if(previous?.isConnected)previous.focus();};
  },[open]);
  useEffect(()=>setOpen(false),[sessionId]);
  const label = session?.active ? '重试 '+session.active.retry+'/'+session.active.maxRetries : session ? (session.maxRetries===0?'重试已关':'重试 '+session.maxRetries+' 次') : '重试设置';
  const modal = open ? createPortal(h('div',{className:'drm-backdrop',onMouseDown:e=>{if(e.target===e.currentTarget)setOpen(false);}},
    h('section',{className:'drm-dialog drm-panel',ref:dialogRef,role:'dialog','aria-modal':true,'aria-label':'当前对话重试设置','data-testid':'retry-session-dialog'},
      h('div',{className:'drm-heading'},h('h2',null,'当前对话重试'),h('button',{type:'button','aria-label':'关闭重试设置',onClick:()=>setOpen(false)},'关闭')),
      h(ErrorText,{text:error}),
      !session ? h('p',{role:'status'},'正在读取本对话配置…') : h(React.Fragment,null,
        h('p',{className:'drm-model'},h('strong',null,session.model||'尚未选择模型'),h('small',null,session.provider||'')),
        h('label',{className:'drm-row'},'本对话重试次数',h(RetrySelect,{label:'本对话重试次数',value:session.override,disabled:busy,onChange:maxRetries=>save({op:'session',sessionId,maxRetries}),inherit:'继承模型／上级设置'})),
        h('p',{className:'drm-muted','data-testid':'retry-effective'},'当前生效：'+SOURCE[session.source]+' · '+session.maxRetries+' 次'),
        session.active ? h('div',{className:'drm-note',role:'status'},
          h('strong',null,(session.active.phase==='waiting'?'等待重试':'正在重试')+' · '+session.active.retry+'/'+session.active.maxRetries),
          h('p',null,'错误类型：'+session.active.code+(session.active.phase==='waiting'?' · 约 '+Math.max(0,Math.ceil((session.active.until-Date.now())/1000))+' 秒后重试':'')),
          h('button',{type:'button',disabled:busy,onClick:()=>save({op:'cancel',sessionId,retryId:session.active.retryId})},'取消本次重试')) : h('p',{className:'drm-muted'},'当前没有进行中的重试。'),
        h(BusyLabel,{busy}),
        h('p',{className:'drm-foot'},'0 次为关闭。只影响当前对话；已有的失败步骤使用开始恢复时的设置。取消会停止当前轮次，保留排队消息。')),
      error ? h('button',{type:'button',onClick:()=>refresh()},'重新读取') : null)),document.body) : null;
  return h(React.Fragment,null,h('button',{className:'drm-trigger','aria-label':'当前对话重试设置','aria-haspopup':'dialog','aria-expanded':open,'data-testid':'retry-session-trigger',title:'当前对话重试设置',onClick:()=>{setOpen(true);refresh();}},label),modal);
}
function apply(ctx) {
  const style=document.createElement('style'); style.dataset.plugin='dsh-retry-manager'; style.textContent=CSS; document.head.appendChild(style);
  ctx.effect(()=>()=>style.remove());
  ctx.slots.inject('settings.plugins.tab',()=>ctx.slots.register({name:'settings.plugins.tab',id:'dsh-retry-manager',order:45,label:()=> '请求重试'},SettingsCard));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'dsh-retry-manager',order:25},SessionControl));
}
