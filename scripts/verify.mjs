/** Verify the prebuilt distribution without importing or activating plugin code. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(resolve(root, 'SNAPSHOT.json'), 'utf8'));
assert.equal(pkg.name, 'dsh-pet');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.equal(pkg.exports['./client'].default, './lib/client.js');
assert.equal(pkg.exports['./memory'].default, './plugins/memory/lib/index.js');
assert.equal(pkg.dependencies['@deepseek-ai/schemastery'], '^3.18.1');
assert.match(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), /id: memory\s+name: dsh-pet\/memory/);
for (const name of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
  assert.equal(pkg.scripts?.[name], undefined, `Unexpected lifecycle script: ${name}`);
}
assert.match(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), /id: dsh-pet\s+name: dsh-pet/);
for (const [relative, expected] of Object.entries(snapshot.sha256)) {
  const actual = createHash('sha256').update(readFileSync(resolve(root, relative))).digest('hex');
  assert.equal(actual, expected, `Snapshot mismatch: ${relative}`);
}
for (const language of ['en', 'zh']) {
  const meta = JSON.parse(readFileSync(resolve(root, `locale/${language}.json`), 'utf8')).meta;
  assert.ok(meta.title && meta.description);
  const memoryMeta = JSON.parse(readFileSync(resolve(root, `plugins/memory/locale/${language}.json`), 'utf8')).meta;
  assert.ok(memoryMeta.title && memoryMeta.description);
}
const icon = readFileSync(resolve(root, pkg.icon));
assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
assert.ok(icon.length <= 256 * 1024);
const client = readFileSync(resolve(root, 'lib/client.js'), 'utf8');
assert.ok(client.includes('__ModuleLoader__.load'));
assert.ok(client.includes('dsh-pet'));
for (const entry of ['lib/index.js', 'lib/client.js', 'plugins/memory/lib/index.js', 'runtime/electron-helper/main.js', 'runtime/electron-helper/preload.js']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, entry)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Syntax check failed: ${entry}`);
}
const media = readdirSync(resolve(root, 'assets/webm')).filter(name => name.endsWith('.webm'));
assert.ok(media.includes('待机呼吸休闲.webm'));
assert.ok(media.every(name => statSync(resolve(root, 'assets/webm', name)).size > 0));
console.log(`Verified ${Object.keys(snapshot.sha256).length} snapshot files and ${media.length} animations; no plugin code activated.`);
