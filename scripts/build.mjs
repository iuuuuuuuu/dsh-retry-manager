import { mkdir, readdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
await mkdir(new URL('lib/', root), { recursive: true });
for (const file of await readdir(new URL('src/', root))) {
  if (file.endsWith('.js') && file !== 'client.js') await copyFile(new URL('src/' + file, root), new URL('lib/' + file, root));
}
const source = await readFile(new URL('src/client.js', root), 'utf8');
const script = 'window.__ModuleLoader__.load({id:"dsh-retry-manager",factory:function(require){\n"use strict";\n' + source + '\nreturn {name:"dsh-retry-manager",inject:["slots","connection"],apply};\n}});\n';
await writeFile(new URL('lib/client.js', root), script);
console.log('Built host modules and DSH client module.');
