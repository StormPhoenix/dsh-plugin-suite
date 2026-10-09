/** Check independent installation manifests, resources and syntax without activating plugins. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
assert.equal(json(resolve(root, 'package.json')).dsh, undefined);
function checkClient(pkg) {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.exports['./client']?.default, './lib/client.js');
}
for (const [folder, name, id] of [['pet', 'dsh-pet', 'dsh-pet'], ['memory', 'dsh-memory', 'memory']]) {
  const dir = resolve(root, 'plugins', folder);
  const pkg = json(resolve(dir, 'package.json'));
  assert.equal(pkg.name, name);
  const require = createRequire(resolve(dir, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(require.resolve(dependency), `Missing runtime dependency: ${dependency}; run pnpm install at repository root`);
  }
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  for (const script of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts?.[script], undefined);
  for (const value of Object.values(pkg.exports)) {
    for (const target of typeof value === 'string' ? [value] : Object.values(value)) {
      assert.ok(target.startsWith('./') && !target.includes('..'));
      if (!target.includes('*')) assert.ok(existsSync(resolve(dir, target)), target);
    }
  }
  assert.equal(dirname(dirname(resolve(dir, pkg.exports['.'].default))), dir);
  const patch = readFileSync(resolve(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal((patch.match(/\bid:/g) ?? []).length, 1);
  assert.match(patch, new RegExp(`id: ${id}\\s+name: ${name}(?:\\s|$)`));
  assert.doesNotMatch(patch, /dsh-pet\/memory/);
  for (const language of ['en', 'zh']) {
    const meta = json(resolve(dir, 'locale', `${language}.json`)).meta;
    assert.ok(meta.title && meta.description);
  }
  for (const entry of ['lib/index.js', ...(folder === 'pet' ? ['lib/client.js'] : [])]) {
    const result = spawnSync(process.execPath, ['--check', resolve(dir, entry)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
  }
  if (folder === 'pet') {
    checkClient(pkg);
    assert.match(readFileSync(resolve(dir, 'lib/client.js'), 'utf8'), /id: "dsh-pet"/);
    const missingDeclaration = structuredClone(pkg);
    delete missingDeclaration.dsh.client;
    assert.throws(() => checkClient(missingDeclaration));
    const missingEntry = structuredClone(pkg);
    delete missingEntry.exports['./client'];
    assert.throws(() => checkClient(missingEntry));
  } else {
    assert.equal(pkg.dsh.client, undefined);
    assert.match(patch, /path: !!js dshHomePath\('memory\/memory\.db'\)/);
  }
}
console.log('Distribution checks passed: independent dsh-pet and dsh-memory Bundles.');
