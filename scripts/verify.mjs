/** Static distribution check: manifest shape, entry syntax, and resources. Never imports plugins or opens databases. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const pkg = readJson('package.json');

// Root identity and bundle shape.
assert.equal(pkg.name, 'dsh-pet');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(pkg.dsh.client.platform, 'web');
assert.equal(pkg.exports['.'].default, './plugins/pet/lib/index.js');
assert.equal(pkg.exports['./client'].default, './plugins/pet/lib/client.js');
assert.equal(pkg.exports['./memory'].default, './plugins/memory/lib/index.js');
for (const name of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
  assert.equal(pkg.scripts?.[name], undefined, `Unexpected lifecycle script: ${name}`);
}

// Both entries are independent plugin rows.
const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id: dsh-pet\s+name: dsh-pet/);
assert.match(patch, /id: memory\s+name: dsh-pet\/memory/);
assert.match(patch, /path: !!js dshHomePath\('memory\/memory\.db'\)/);

// Critical entries must parse as JavaScript.
for (const entry of [
  'plugins/pet/lib/index.js',
  'plugins/pet/lib/client.js',
  'plugins/memory/lib/index.js'
]) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, entry)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Syntax check failed: ${entry}`);
}

// Client module id must equal the root package name.
const client = readFileSync(resolve(root, 'plugins/pet/lib/client.js'), 'utf8');
assert.ok(client.includes('__ModuleLoader__.load'));
assert.match(client, /id: "dsh-pet"/);

// Each entry carries its own display resources.
for (const language of ['en', 'zh']) {
  for (const dir of ['plugins/pet/locale', 'plugins/memory/locale']) {
    const meta = readJson(`${dir}/${language}.json`).meta;
    assert.ok(meta.title && meta.description, `${dir}/${language}.json`);
  }
}

console.log('Static distribution check passed: one dsh-pet bundle with equal pet and memory entries.');
