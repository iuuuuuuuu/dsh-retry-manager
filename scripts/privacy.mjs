import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const excluded=new Set(['node_modules','.git']);const failures=[];let checked=0;
const machinePath=new RegExp('[A-Za-z]:/+(?:'+['Users','WishProject','DSHHome'].join('|')+')','i');
const secret=new RegExp('(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{24,}');
async function scan(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(excluded.has(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())await scan(p);else if(/\.(?:js|mjs|json|md|ya?ml)$/.test(e.name)){checked++;const t=await readFile(p,'utf8');if(machinePath.test(t.replaceAll(String.fromCharCode(92),'/'))||secret.test(t))failures.push(relative(root,p));}}}
await scan(root);if(checked<10)throw Error('Privacy gate scanned too few files');if(failures.length)throw Error('Potential local path or secret in: '+failures.join(', '));console.log('Privacy scan passed: '+checked+' source files.');
