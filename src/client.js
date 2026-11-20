const React = require('react');
const { Menu, MenuItemButton, Modal, IconChevronDownOutlineRegular, IconSearchOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
const h = React.createElement;
const { useState, useEffect, useCallback, useRef, useId } = React;
const API = new URL('api/dsh-retry-manager', document.baseURI).pathname;
const SOURCE = {session: '本对话', model: '模型默认', default: '全局默认', provider: '提供商默认'};
const CSS = `
.drm-panel{font-family:inherit;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.drm-panel *,.drm-select-menu *{box-sizing:border-box}.drm-panel h2{font-size:18px;line-height:1.4;margin:0 0 6px;font-weight:650}.drm-panel h3{font-size:14px;margin:0 0 4px;font-weight:600}.drm-panel p{margin:6px 0 12px}
.drm-heading,.drm-row,.drm-rule{display:flex;align-items:center;justify-content:space-between;gap:16px}.drm-heading{align-items:flex-start;margin-bottom:20px}.drm-muted,.drm-foot,.drm-model small{color:var(--dsw-alias-label-tertiary)}.drm-foot{font-size:12px;margin-top:20px!important}.drm-tag{font-size:11px;border:1px solid var(--dsw-alias-border-l2);padding:3px 8px;border-radius:20px;white-space:nowrap}
.drm-note{padding:12px 14px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);margin:14px 0 18px}.drm-card{border:1px solid var(--dsw-alias-border-l2);padding:18px;border-radius:var(--dsw-radius-lg);margin:16px 0}
.drm-panel button,.drm-panel input{font:inherit;color:inherit;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);min-height:36px;padding:6px 10px;max-width:100%}.drm-panel button{cursor:pointer;white-space:nowrap}.drm-panel button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.drm-panel button:disabled,.drm-panel input:disabled{opacity:.5;cursor:not-allowed}.drm-panel input:focus-visible,.drm-panel button:focus-visible,.drm-select-search input:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.drm-card>.drm-row{flex-wrap:wrap}.drm-card>.drm-row>div{flex:1 1 200px}.drm-global{flex:1 1 100%;min-width:0}.drm-inherit{display:flex;align-items:center;gap:8px;margin-bottom:10px}.drm-panel .drm-inherit input{min-height:0;width:15px;height:15px;padding:0;accent-color:var(--dsw-alias-state-business-primary)}.drm-global-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}.drm-global-controls label{display:flex;align-items:center;gap:8px}.drm-global-controls input{width:90px}.drm-interval{margin:14px 0;padding:12px 0;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}.drm-interval>.drm-muted,.drm-global>.drm-muted{font-size:12px;margin:10px 0 4px}.drm-primary{background:var(--dsw-alias-state-business-primary)!important;color:var(--dsw-palette-white,#fff)!important;border-color:transparent!important}
.drm-add{display:grid;grid-template-columns:minmax(130px,1fr) minmax(140px,1.3fr) 100px auto;align-items:end;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px;margin-top:16px}.drm-add label{display:flex;flex-direction:column;gap:6px;font-size:12px;min-width:0}.drm-add input{width:100%}.drm-rule{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.drm-rule:last-child{border-bottom:0}.drm-model{min-width:0;overflow-wrap:anywhere}.drm-model strong,.drm-model small{display:block}.drm-model small{font-size:12px}.drm-empty{padding:12px 0;color:var(--dsw-alias-label-tertiary)}.drm-error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);padding:10px;border-radius:var(--dsw-radius-md)}
.drm-select{display:inline-flex;min-width:0;max-width:100%}.drm-select-count{flex:none;min-width:150px}.drm-add .drm-select{display:flex;width:100%}.drm-panel .drm-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;text-align:left;transition:background 120ms,border-color 120ms}.drm-select-trigger[aria-expanded=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.drm-select-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.drm-select-placeholder{color:var(--dsw-alias-label-tertiary)}.drm-select-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform 120ms}.drm-select-trigger[aria-expanded=true] .drm-select-chevron{transform:rotate(180deg)}
.drm-select-menu{font-family:inherit;color:var(--dsw-alias-label-primary);min-width:min(240px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px));max-height:min(380px,calc(100dvh - 32px))}.drm-select-menu>.drm-select-content{min-height:0}.drm-select-content{display:flex;flex-direction:column;min-height:0}.drm-select-search{display:flex;align-items:center;gap:8px;padding:8px 8px 10px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}.drm-select-search svg{flex:none}.drm-select-search input{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform);border:0;border-radius:var(--dsw-radius-md);padding:7px 9px;width:100%;min-width:0;line-height:20px}.drm-select-search input::placeholder{color:var(--dsw-alias-label-tertiary)}.drm-select-options{overflow-y:auto;min-height:0;max-height:min(260px,calc(100dvh - 180px));padding:4px 0;overscroll-behavior:contain}.drm-select-item{display:flex;flex-direction:column;gap:1px;min-width:0}.drm-select-item>span,.drm-select-item>small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.drm-select-item>small{font-size:11px;color:var(--dsw-alias-label-tertiary)}.drm-select-summary{flex:none;padding:6px 8px 4px;border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}.drm-select-empty{margin:0;padding:18px 10px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.drm-trigger{font-family:inherit;font-size:12px;line-height:1.4;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:4px 8px;cursor:pointer;white-space:nowrap}.drm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}.drm-session-modal{width:490px;max-width:calc(100vw - 32px)}.drm-session-body{min-width:0}
@media(max-width:800px){.drm-add{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.drm-row{flex-wrap:wrap}.drm-card{padding:14px}}@media(max-width:420px){.drm-add{grid-template-columns:minmax(0,1fr)}.drm-rule{flex-wrap:wrap}.drm-rule .drm-select{width:100%}.drm-session-body>.drm-row{align-items:stretch;flex-direction:column}.drm-session-body .drm-select{width:100%}}

.drm-errors{margin-top:20px}.drm-error-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:12px 0}.drm-error-toolbar input{min-width:180px;flex:1}.drm-error-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px;margin:12px 0;min-width:0}.drm-error-card h4{font-size:13px;margin:0;overflow-wrap:anywhere}.drm-error-message{font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-module-platform);padding:10px;border-radius:var(--dsw-radius-md);margin:10px 0;max-height:150px;overflow:auto}.drm-error-meta{display:flex;gap:6px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;margin:7px 0}.drm-error-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:end}.drm-error-actions>label{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px}.drm-error-actions .drm-select{width:100%}.drm-rule-list{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.drm-rule-list>div{min-width:0;overflow-wrap:anywhere}.drm-rule-list strong{display:block}.drm-error-history{margin-top:10px;font-size:12px}.drm-error-history summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.drm-error-history ol{padding-left:20px}.drm-error-history li{margin:8px 0;overflow-wrap:anywhere}.drm-warning{padding:10px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-state-warn-label)}.drm-confirm{max-width:520px}.drm-confirm-body{min-width:0}.drm-confirm-body button{margin:10px 8px 0 0}.drm-inbox-modal{width:780px;max-width:calc(100vw - 24px)}.drm-error-tabs{display:flex;gap:8px;margin:4px 0 16px}.drm-error-tabs button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-state-business-primary)}
@media(max-width:640px){.drm-error-actions{grid-template-columns:minmax(0,1fr)}.drm-error-actions>button{width:100%}.drm-rule-list{flex-wrap:wrap}}
.drm-inbox-modal{max-height:calc(100dvh - max(24px,var(--dsh-frame-overlay-top,24px)) - 24px);max-height:min(900px,calc(100dvh - max(24px,var(--dsh-frame-overlay-top,24px)) - 24px))}.drm-inbox-content{min-height:0;overflow:hidden;flex:1 1 auto}.drm-inbox-content>:first-child{flex-shrink:0}.drm-inbox-content>:last-child{min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.drm-inbox-list{max-height:min(600px,56dvh);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:0 4px}.drm-inbox-list>:first-child{margin-top:0}.drm-inbox-content .drm-inbox-list{max-height:none;overflow:visible;padding:0}.drm-inbox-pages{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:12px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}.drm-inbox-pages>div{display:flex;gap:8px}.drm-error-variant{display:flex;flex-direction:column;gap:6px;margin:10px 0;font-size:12px;min-width:0}.drm-error-variant>.drm-select{width:100%}.drm-inbox-content .drm-errors{margin-top:0}
@media(prefers-reduced-motion:reduce){.drm-select-chevron,.drm-select-trigger{transition:none}}
`;

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
// Reuse DSH's Menu surface, positioning, navigation and focus return.
function SearchableSelect({value, options, onChange, disabled, label, placeholder, allowCustom = false, count = false}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const triggerRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const restoreAfterSelection = useRef(false);
  const id = useId();
  const current = options.find(option => option.value === value);
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = options.filter(option => words.every(word => (option.label + ' ' + option.value).toLocaleLowerCase().includes(word)));
  const custom = allowCustom && query.trim() && !options.some(option => option.value === query.trim());
  const position = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const above = innerHeight - rect.bottom < 400 && rect.top > innerHeight - rect.bottom;
    setAnchor({x:rect.left, y:above ? rect.top : rect.bottom, side:above ? 'top' : 'bottom'});
  }, []);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    // A viewport anchor avoids CSS-anchor double scroll compensation inside Settings.
    const moved = event => { if (event.type === 'resize' || event.target === document || event.target?.contains?.(triggerRef.current)) position(); };
    document.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    return () => { document.removeEventListener('scroll', moved, true); window.removeEventListener('resize', moved); };
  }, [open, position]);
  useEffect(() => { if (open) searchRef.current?.focus({preventScroll:true}); }, [open]);
  useEffect(() => {
    if (!open && !disabled && restoreAfterSelection.current) {
      restoreAfterSelection.current = false;
      triggerRef.current?.focus({preventScroll:true});
    }
  }, [open, disabled]);
  const choose = selected => {
    restoreAfterSelection.current = true;
    setOpen(false);
    triggerRef.current?.focus({preventScroll:true});
    onChange(selected);
  };
  return h('span', {className:'drm-select' + (count ? ' drm-select-count' : '')},
    h('button', {ref:triggerRef, type:'button', className:'drm-select-trigger', disabled, 'aria-label':label, 'aria-haspopup':'menu', 'aria-expanded':open,
      title:current?.label || value || placeholder, onClick:() => { setQuery(''); position(); setOpen(!open); }},
      h('span', {className:'drm-select-label' + (!current && !value ? ' drm-select-placeholder' : '')}, current?.label || value || placeholder),
      h(IconChevronDownOutlineRegular, {size:14, className:'drm-select-chevron', 'aria-hidden':true})),
    h(Menu, {open, onClose:() => setOpen(false), portal:true, anchor:null, anchorPoint:anchor, side:anchor?.side,
      returnFocus:() => triggerRef.current, isExternalTrigger:node => triggerRef.current?.contains(node) === true, listClassName:'drm-select-menu'},
    h('div', {className:'drm-select-content'},
      h('div', {className:'drm-select-search'}, h(IconSearchOutlineRegular, {size:16, 'aria-hidden':true}),
        h('input', {ref:searchRef, role:'searchbox', 'aria-label':label+'筛选', 'aria-controls':id, autoComplete:'off',
          placeholder:allowCustom ? '筛选名称 / ID，或输入自定义 ID' : '输入次数或关键词筛选', value:query, maxLength:allowCustom ? 240 : 80,
          onChange:event => setQuery(event.target.value), onKeyDown:event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (['Home','End','ArrowLeft','ArrowRight'].includes(event.key)) event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault(); event.stopPropagation();
              if (matches.length) choose(matches[0].value); else if (custom) choose(query.trim());
            }
          }})),
      h('div', {id, className:'drm-select-options', 'aria-label':label+'候选项'},
        ...matches.map(option => h(MenuItemButton, {key:'option:'+option.value, selected:option.value===value, disabled, onSelect:() => choose(option.value), title:option.label+' · '+option.value},
          h('span', {className:'drm-select-item'}, h('span', null, option.label), option.label!==option.value && allowCustom ? h('small', null, option.value) : null))),
        custom ? h(MenuItemButton, {key:'custom', disabled, onSelect:() => choose(query.trim())}, h('span', {className:'drm-select-item'}, h('span', null, '使用自定义 ID'), h('small', null, query.trim()))) : null,
        !matches.length && !custom ? h('p', {className:'drm-select-empty', role:'status'}, options.length ? '没有匹配项，换个关键词试试' : '目录暂无候选项，可输入自定义 ID') : null),
      h('div', {className:'drm-select-summary', role:'status', 'aria-live':'polite'}, '匹配 '+matches.length+' 项'+(allowCustom ? ' · 支持手动填写 ID' : ' · ↑↓ 选择，Enter 确认')))));
}
function RetrySelect({value, onChange, disabled, label, inherit = '继承上级设置'}) {
  const options = [{value:'inherit', label:inherit}, ...Array.from({length:101}, (_, n) => ({value:String(n), label:n===0 ? '关闭重试（0 次）' : n+' 次重试'}))];
  return h(SearchableSelect, {value:value===null ? 'inherit' : String(value), options, disabled, label, count:true,
    onChange:selected => onChange(selected==='inherit' ? null : Number(selected))});
}
function BusyLabel({busy}) { return busy ? h('span', {className:'drm-muted', role:'status'}, '正在保存…') : null; }
function GlobalRetryInput({value, intervalValue, disabled, onSave}) {
  const [inherit, setInherit] = useState(value === null);
  const [draft, setDraft] = useState(String(value ?? 5));
  useEffect(() => { setInherit(value === null); setDraft(String(value ?? 5)); }, [value]);
  const [inheritInterval, setInheritInterval] = useState(intervalValue === null);
  const [intervalDraft, setIntervalDraft] = useState(String((intervalValue ?? 1000) / 1000));
  useEffect(() => { setInheritInterval(intervalValue === null); setIntervalDraft(String((intervalValue ?? 1000) / 1000)); }, [intervalValue]);
  const countChanged = inherit ? value !== null : value === null || draft === '' || Number(draft) !== value;
  const intervalChanged = inheritInterval ? intervalValue !== null : intervalValue === null || intervalDraft === '' || Math.round(Number(intervalDraft) * 1000) !== intervalValue;
  const changed = countChanged || intervalChanged;
  return h('form', {className:'drm-global', onSubmit:async event => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    await onSave(inherit ? null : Number(draft), inheritInterval ? null : Math.round(Number(intervalDraft) * 1000));
  }},
    h('label', {className:'drm-inherit'}, h('input', {type:'checkbox', checked:inherit, disabled,
      onChange:event => setInherit(event.target.checked)}), '继承提供商设置'),
    h('div', {className:'drm-global-controls'},
      h('label', null, '重试次数', h('input', {type:'number', 'aria-label':'全局重试次数', min:0, max:100, step:1,
        required:true, value:draft, disabled:disabled || inherit, onChange:event => setDraft(event.target.value)})),
      h('span', {className:'drm-muted'}, '0 为关闭，最多 100 次')),
    h('div', {className:'drm-interval'},
      h('label', {className:'drm-inherit'}, h('input', {type:'checkbox', checked:inheritInterval, disabled,
        onChange:event => setInheritInterval(event.target.checked)}), '继承提供商重试间隔'),
      h('div', {className:'drm-global-controls'},
        h('label', null, '重试间隔（秒）', h('input', {type:'number', 'aria-label':'全局重试间隔（秒）', min:0.1, max:3600, step:0.1,
          required:true, value:intervalDraft, disabled:disabled || inheritInterval, onChange:event => setIntervalDraft(event.target.value)}))),
      h('p', {className:'drm-muted'}, '自定义为固定本地间隔，支持 0.1–3600 秒，适用于所有模型和对话。适配器提供的服务端 Retry-After 仍按官方规则处理，超过间隔上限时停止自动重试。')),
    h('button', {type:'submit', className:'drm-primary', disabled:disabled || !changed}, '保存全局默认'),
    h('p', {className:'drm-muted'}, '输入后按 Enter 或点击保存；保存后无需重启，当前已开始的重试保持原设置。'),
    h('span', {className:'drm-muted', role:'status'}, disabled ? '正在保存…' : changed ? '尚未保存' : '已保存'));
}
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
  const providers = [...new Map(catalog.map(x => [x.provider, {value:x.provider, label:x.providerName || x.provider}])).values()];
  return h('section', {className: 'drm-panel', 'data-testid': 'retry-settings'},
    h('div', {className:'drm-heading'}, h('div', null, h('h2', null, '模型请求重试'), h('p', {className:'drm-muted'}, '网络中断时自动重试失败步骤，不重放已执行的工具。')), h('span', {className:'drm-tag'}, 'Retry Manager')),
    h('div', {className:'drm-note'}, '优先级：当前对话 ＞ 模型 ＞ 全局 ＞ 提供商。设置 3 次，表示首次失败后最多再请求 3 次；每个新步骤重新计数。'),
    h(ErrorText, {text:error}),
    !data ? h('p', {role:'status'}, '正在读取配置…') : h(React.Fragment, null,
      h('div', {className:'drm-card'}, h('div', {className:'drm-row'}, h('div', null, h('h3',null,'全局默认'), h('p',{className:'drm-muted'},'次数仅在没有模型规则和对话覆盖时使用；间隔统一作用于所有模型和对话。')),
        h(GlobalRetryInput, {value:data.defaultMaxRetries, intervalValue:data.retryIntervalMs ?? null, disabled:busy, onSave:(maxRetries,retryIntervalMs)=>save({op:'default',maxRetries,retryIntervalMs})}))),
      h('div', {className:'drm-card'}, h('h3',null,'按模型设置'), h('p',{className:'drm-muted'},'模型用“提供商 + 模型 ID”识别，同名模型不会串用设置。'),
        data.models.length === 0 ? h('p',{className:'drm-empty'},'尚未添加模型规则，当前继承上级设置。') : h('div',{className:'drm-rules'},...data.models.map(rule=>h('div',{className:'drm-rule',key:JSON.stringify([rule.provider,rule.model])},
          h('div',{className:'drm-model'},h('strong',null,rule.model),h('small',null,rule.provider)),
          h(RetrySelect,{label:rule.provider+'/'+rule.model+' 重试次数',value:rule.maxRetries, disabled:busy,onChange:maxRetries=>save({op:'model',provider:rule.provider,model:rule.model,maxRetries}),inherit:'移除规则，继承上级'})))),
        h('form',{className:'drm-add',onSubmit:async e=>{e.preventDefault(); if(await save({op:'model',provider:provider.trim(),model:model.trim(),maxRetries:amount})){setModel('');}}},
          h('label',null,'提供商 ID',h(SearchableSelect,{label:'提供商 ID',value:provider,options:providers,allowCustom:true,placeholder:'选择或输入提供商',disabled:busy,onChange:selected=>{setProvider(selected);setModel('');}})),
          h('label',null,'模型 ID',h(SearchableSelect,{label:'模型 ID',value:model,options:catalog.filter(x=>x.provider===provider).map(x=>({value:x.model,label:x.name || x.model})),allowCustom:true,placeholder:'选择或输入模型',disabled:busy,onChange:setModel})),
          h('label',null,'重试次数',h('input',{type:'number','aria-label':'新增模型重试次数',min:0,max:100,step:1,required:true,value:amount,onChange:e=>setAmount(Number(e.target.value))})),
          h('button',{className:'drm-primary',type:'submit',disabled:busy || !provider || !model},'保存模型规则')),
        catalogError ? h('p',{className:'drm-muted'},'模型目录暂不可用，可手动填写 ID。'+catalogError) : null),
      h('div',{className:'drm-row'},h(BusyLabel,{busy}),h('button',{type:'button',onClick:()=>refresh(),disabled:busy},'刷新配置')),
      h(ErrorInbox,{onRulesChanged:()=>refresh()})),
    h('p',{className:'drm-foot'},'默认只重试可恢复的模型错误。认证／配额／参数错误默认不重试，精准放行需额外确认；手动停止和专属恢复不会被覆盖。规则对下一失败步骤生效，每次重试可能产生费用。'));
}
const ERROR_ACTION = {keep:'保持原规则', allow:'允许重试', deny:'不重试'};
const ERROR_SCOPE = {session:'当前会话', model:'当前提供商／模型', global:'全局'};
const ERROR_OUTCOME = {observed:'已观察', scheduled:'已安排重试', retrying:'已发起下一次请求', terminal:'本轮终止'};
function ErrorRuleEditor({group, sessionId, busy, onSave, onConfirm}) {
  const [scope, setScope] = useState('model');
  const [action, setAction] = useState('keep');
  const [capturedSession] = useState(group.latest.sessionId);
  const targetSession = sessionId || capturedSession;
  const scopes = [{value:'model',label:ERROR_SCOPE.model},{value:'session',label:sessionId?ERROR_SCOPE.session:'该错误的记录会话'},{value:'global',label:ERROR_SCOPE.global}];
  const actions = Object.entries(ERROR_ACTION).map(([value,label])=>({value,label}));
  const locked = group.protected || !group.current.canOverride;
  return h(React.Fragment,null,scope==='session'&&!sessionId?h('p',{className:'drm-muted'},'规则目标会话：'+targetSession):null,h('form',{className:'drm-error-actions',onSubmit:event=>{
    event.preventDefault();
    const input={op:'error-rule',errorId:group.id,scope,action,sessionId:targetSession};
    if(action==='allow' && (group.requiresConfirmation || scope==='global'))onConfirm({input,group});else onSave(input);
  }},
    h('label',null,'作用范围',h(SearchableSelect,{label:'错误规则范围 '+group.id,value:scope,options:scopes,onChange:setScope,disabled:busy})),
    h('label',null,'处理方式',h(SearchableSelect,{label:'错误规则处理 '+group.id,value:action,options:actions.filter(x=>group.protected ? x.value==='keep' : !locked || x.value!=='allow'),onChange:setAction,disabled:busy})),
    h('button',{type:'submit',className:'drm-primary',disabled:busy || action==='allow' && locked},'保存错误规则')));
}
const INBOX_PAGE_SIZE = 5;
function InboxPages({page, total, onChange, busy}) {
  const pages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  return h('nav',{className:'drm-inbox-pages','aria-label':'收件箱分页'},
    h('span',{role:'status','data-testid':'retry-inbox-page'},'共 '+total+' 项 · 第 '+(page+1)+' / '+pages+' 页 · 每页 '+INBOX_PAGE_SIZE+' 项'),
    h('div',null,h('button',{type:'button',disabled:busy||page===0,onClick:()=>onChange(page-1)},'上一页'),
      h('button',{type:'button',disabled:busy||page>=pages-1,onClick:()=>onChange(page+1)},'下一页')));
}
function ErrorFamilyCard({family,sessionId,busy,onSave,onConfirm}) {
  const [selected,setSelected] = useState(family.variants[0].id);
  const group = family.variants.find(item=>item.id===selected) || family.variants[0];
  return h('article',{className:'drm-error-card','data-error-code':group.error.code,'data-error-status':group.error.status,'data-testid':'retry-error-group'},
    h('h4',null,group.error.code+(group.error.status?' · HTTP '+group.error.status:'')),
    h('div',{className:'drm-error-meta'},h('span',null,family.provider+' / '+family.model),
      h('span',null,'出现 '+family.count+' 次'),h('span',null,family.variants.length+' 种具体错误'),h('span',null,new Date(family.lastSeen).toLocaleString())),
    family.variants.length>1?h('label',{className:'drm-error-variant'},'具体错误（规则仅作用于选中特征）',
      h(SearchableSelect,{label:'选择具体错误',value:group.id,disabled:busy,onChange:setSelected,
        options:family.variants.map(item=>({value:item.id,label:item.error.message+' · '+item.count+' 次'}))})):null,
    h('pre',{className:'drm-error-message'},group.error.message),
    h('p',{className:'drm-muted'},'当前规则'+(sessionId?'':'（该特征最近记录的会话）')+'：'+ERROR_ACTION[group.current.action]+' · '+(group.current.source==='original'?'原始策略':ERROR_SCOPE[group.current.source])+' · '+(group.current.retryable?'允许':'不允许')+'重试 · 预算 '+group.current.maxRetries+' 次'),
    group.requiresConfirmation?h('p',{className:'drm-warning'},'认证／配额／配置等风险错误，放行需要额外确认。只匹配选中错误特征，不放行其他具体错误。'):null,
    !group.current.canOverride?h('p',{className:'drm-muted'},'此记录未进入请求重试边界，或由取消／专属恢复处理，不可强制放行。'):null,
    h(ErrorRuleEditor,{key:group.id,group,sessionId,busy,onSave,onConfirm}),
    h('details',{className:'drm-error-history',key:'history:'+group.id},h('summary',null,'选中特征 '+group.count+' 次 · 最近 '+group.occurrences.length+' 次请求记录'),
      h('ol',null,...group.occurrences.map(entry=>h('li',{key:entry.id},new Date(entry.time).toLocaleString()+' · '+entry.sessionId+' · 第 '+entry.turn+' 轮 / 第 '+entry.step+' 步 · 事件 #'+entry.seq+' · '+ERROR_OUTCOME[entry.outcome],
        entry.decision?h('div',{className:'drm-muted'},'发生时：'+ERROR_ACTION[entry.decision.action]+' · '+(entry.decision.retryable?'策略允许重试':'策略不重试')):null)))));
}
function ErrorInbox({sessionId,onRulesChanged}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState(''),[tab,setTab]=useState('errors'),[confirmation,setConfirmation]=useState(null),[notice,setNotice]=useState(''),[page,setPage]=useState(0);
  const listRef=useRef(null);
  const query='?errors=1'+(sessionId?'&session='+encodeURIComponent(sessionId):'');
  const refresh=useCallback(async(signal)=>{
    try {const next=await api(query,undefined,signal);setData(next);setError('');return next;}
    catch(e){if(e.name!=='AbortError')setError(e.message);}
  },[query]);
  useEffect(()=>{const abort=new AbortController();setData(null);setPage(0);refresh(abort.signal);const timer=setInterval(()=>{if(document.visibilityState!=='hidden')refresh(abort.signal);},5000);return()=>{abort.abort();clearInterval(timer);};},[refresh]);
  const save=async input=>{
    setBusy(true);setError('');setNotice('');
    try {await api('',input.op==='sync-errors'?input:{...input,revision:data?.revision});await refresh();onRulesChanged?.();setNotice(input.op==='sync-errors'?'已读取本会话最近的错误；未恢复运行。':'已保存，仅影响下一次尚未开始恢复的模型步骤；未重跑已结束轮次。');setConfirmation(null);return true;}
    catch(e){setError(e.message);return false;}
    finally{setBusy(false);}
  };
  const matching=text=>filter.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word=>text.toLocaleLowerCase().includes(word));
  const families=(data?.families || (data?.groups||[]).map(group=>({...group,familyKey:group.id,variants:[group]})))
    .map(family=>({...family,variants:family.variants.filter(group=>matching(group.provider+' '+group.model+' '+group.error.code+' '+(group.error.status??'')+' '+group.error.message))}))
    .filter(family=>family.variants.length);
  const rules=(data?.rules||[]).filter(rule=>matching(rule.error.message+' '+rule.error.code+' '+rule.target));
  const items=tab==='rules'?rules:families,total=items.length,lastPage=Math.max(0,Math.ceil(total/INBOX_PAGE_SIZE)-1),currentPage=Math.min(page,lastPage);
  const changePage=next=>{setPage(next);if(listRef.current)listRef.current.scrollTop=0;};
  useEffect(()=>{if(page!==currentPage)setPage(currentPage);},[page,currentPage]);
  return h('section',{className:'drm-errors','data-testid':'retry-error-inbox'},
    h('div',{className:'drm-heading'},h('div',null,h('h3',null,'错误收件箱'),h('p',{className:'drm-muted'},'同一提供商／模型的同类错误合并计数，具体特征分别保留。默认保持现有规则。'))),
    h('div',{className:'drm-error-tabs'},h('button',{type:'button','aria-pressed':tab==='errors',onClick:()=>{setTab('errors');changePage(0);}},'收集的错误'),h('button',{type:'button','aria-pressed':tab==='rules',onClick:()=>{setTab('rules');changePage(0);}},'自定义规则')),
    h(ErrorText,{text:error||data?.collectionError}),
    h('div',{className:'drm-error-toolbar'},h('input',{'aria-label':'筛选错误',value:filter,placeholder:'筛选错误、提供商或模型',onChange:e=>{setFilter(e.target.value);changePage(0);}}),
      sessionId?h('button',{type:'button',disabled:busy,onClick:()=>save({op:'sync-errors',sessionId})},'读取本会话已有错误'):null,
      h('button',{type:'button',disabled:busy,onClick:()=>refresh()},'刷新错误')),
    notice?h('p',{className:'drm-muted',role:'status'},notice):null,
    !data?h('p',{role:'status'},'正在读取错误…'):h(React.Fragment,null,
      tab==='rules'?h('p',{className:'drm-muted'},'优先级：会话 ＞ 提供商／模型 ＞ 全局。保持原规则会屏蔽更宽范围的自定义规则；撤销后恢复继承。'):null,
      h(InboxPages,{page:currentPage,total,onChange:changePage,busy}),
      h('div',{ref:listRef,className:'drm-inbox-list','data-testid':tab==='rules'?'retry-error-rules':'retry-error-families'},
        !total?h('p',{className:'drm-empty'},filter?'没有匹配项。':tab==='rules'?'没有自定义错误规则，全部沿用现有规则。':'尚未收集到错误。新错误会自动出现；当前对话也可读取已有错误。'):null,
        ...items.slice(currentPage*INBOX_PAGE_SIZE,(currentPage+1)*INBOX_PAGE_SIZE).map(item=>tab==='rules'
          ?h('div',{className:'drm-rule-list',key:item.id},
            h('div',null,h('strong',null,ERROR_ACTION[item.action]+' · '+ERROR_SCOPE[item.scope]),h('small',{className:'drm-muted'},item.target),h('pre',{className:'drm-error-message'},item.error.code+' · '+item.error.message)),
            h('button',{type:'button',disabled:busy,onClick:()=>save({op:'remove-error-rule',ruleId:item.id})},'撤销规则'))
          :h(ErrorFamilyCard,{key:item.familyKey,family:item,sessionId,busy,onSave:save,onConfirm:setConfirmation})))),
    h('p',{className:'drm-foot'},'同类按错误码和 HTTP 状态归并展示；不同具体特征独立设置规则，合并不会放宽已有规则。每页最多 5 项。保留最近 30 天、最多 1000 次错误；原始会话日志不改写，0 次、取消和间隔上限继续生效。'),
    h(Modal,{open:!!confirmation,onClose:()=>{if(!busy)setConfirmation(null);},title:'确认放行错误重试',closeLabel:'取消放行',className:'drm-confirm'},
      confirmation?h('div',{className:'drm-panel drm-confirm-body'},
        h('p',null,'将对“'+ERROR_SCOPE[confirmation.input.scope]+'”内这一条错误特征允许重试，不代表密钥或配额会自行恢复。每次重试可能产生费用。'),
        h('pre',{className:'drm-error-message'},confirmation.group.error.code+' · '+confirmation.group.error.message),
        h('p',{className:'drm-muted'},'仍遵守已有次数、间隔与取消；不会重跑已结束轮次。'),
        h('button',{type:'button',disabled:busy,onClick:()=>setConfirmation(null)},'取消'),
        h('button',{type:'button',className:'drm-primary',disabled:busy,onClick:()=>save({...confirmation.input,confirmRisk:true})},'确认仅放行此错误')):null));
}

function SessionControl({sessionId}) {
  const [open, setOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const {data,error,busy,save,refresh} = useData(sessionId);
  const session = data?.session;
  useEffect(()=>{setOpen(false);setInboxOpen(false);},[sessionId]);
  const label = session?.active ? '重试 '+session.active.retry+'/'+session.active.maxRetries : session ? (session.maxRetries===0?'重试已关':'重试 '+session.maxRetries+' 次') : '重试设置';
  const modal = h(Modal, {open, onClose:()=>setOpen(false), title:'当前对话重试设置', closeLabel:'关闭重试设置', className:'drm-session-modal'},
    h('div', {className:'drm-panel drm-session-body', 'data-testid':'retry-session-dialog'},
      h(ErrorText,{text:error}),
      !session ? h('p',{role:'status'},'正在读取本对话配置…') : h(React.Fragment,null,
        h('p',{className:'drm-model'},h('strong',null,session.model||'尚未选择模型'),h('small',null,session.provider||'')),
        h('label',{className:'drm-row'},'本对话重试次数',h(RetrySelect,{label:'本对话重试次数',value:session.override,disabled:busy,onChange:maxRetries=>save({op:'session',sessionId,maxRetries}),inherit:'继承模型／上级设置'})),
        h('p',{className:'drm-muted','data-testid':'retry-effective'},'当前生效：'+SOURCE[session.source]+' · '+session.maxRetries+' 次 · '+(session.retryIntervalMs === null ? '继承提供商间隔' : '间隔 '+session.retryIntervalMs/1000+' 秒')),
        session.active ? h('div',{className:'drm-note',role:'status'},
          h('strong',null,(session.active.phase==='waiting'?'等待重试':'正在重试')+' · '+session.active.retry+'/'+session.active.maxRetries),
          h('p',null,'错误类型：'+session.active.code+(session.active.phase==='waiting'?' · 约 '+Math.max(0,Math.ceil((session.active.until-Date.now())/1000))+' 秒后重试':'')),
          h('button',{type:'button',disabled:busy,onClick:()=>save({op:'cancel',sessionId,retryId:session.active.retryId})},'取消本次重试')) : h('p',{className:'drm-muted'},'当前没有进行中的重试。'),
        h(BusyLabel,{busy}),
        h('button',{type:'button',onClick:()=>{setOpen(false);setInboxOpen(true);}},'错误收件箱与规则'),
        h('p',{className:'drm-foot'},'0 次为关闭。只影响当前对话；已有的失败步骤使用开始恢复时的设置。取消会停止当前轮次，保留排队消息。')),
      error ? h('button',{type:'button',onClick:()=>refresh()},'重新读取') : null));
  return h(React.Fragment,null,h('button',{className:'drm-trigger','aria-label':'当前对话重试设置','aria-haspopup':'dialog','aria-expanded':open,'data-testid':'retry-session-trigger',title:'当前对话重试设置',onClick:()=>{setOpen(true);refresh();}},label),modal,
    h(Modal,{open:inboxOpen,onClose:()=>setInboxOpen(false),title:'本会话错误收件箱',closeLabel:'关闭错误收件箱',className:'drm-inbox-modal',contentClassName:'drm-inbox-content'},
      inboxOpen?h('div',{className:'drm-panel'},h(ErrorInbox,{sessionId})):null));
}
function apply(ctx) {
  const style=document.createElement('style'); style.dataset.plugin='dsh-retry-manager'; style.textContent=CSS; document.head.appendChild(style);
  ctx.effect(()=>()=>style.remove());
  ctx.slots.inject('settings.plugins.tab',()=>ctx.slots.register({name:'settings.plugins.tab',id:'dsh-retry-manager',order:45,label:()=> '请求重试'},SettingsCard));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'dsh-retry-manager',order:25},SessionControl));
}
