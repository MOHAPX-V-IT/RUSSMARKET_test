import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(e => !e.name.startsWith('.') && e.name !== 'node_modules').map(e => {
    const path = resolve(directory, e.name);
    return e.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}
const files = await walk(root);
let failed = false;
for (const path of files.filter(path => /\.(m?js)$/.test(path))) {
  const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (check.status !== 0) {
    failed = true;
    console.error(check.stderr || check.error?.message);
  }
}
const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  if (match[1].startsWith('/') && !match[1].startsWith('//')) {
    failed = true;
    console.error(`Абсолютный путь несовместим с project Pages: ${match[1]}`);
  }
}
if (failed) process.exitCode = 1;
else console.log(`Проверены синтаксис ${files.filter(path => /\.(m?js)$/.test(path)).length} JS-модулей и относительные пути HTML.`);
