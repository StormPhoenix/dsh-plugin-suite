/** Verify manifests and copied file hashes without importing plugins, opening databases, or running behavior tests. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const suite = readJson('package.json');
const snapshot = readJson('SNAPSHOT.json');
const distribution = readJson('dist/manifest.json');
assert.equal(suite.name, 'dsh-plugin-suite');
assert.equal(suite.dsh.client, undefined);
assert.equal(distribution.suiteVersion, suite.version);
const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8');
assert.match(patch, /id: dsh-pet\s+name: dsh-pet/);
assert.match(patch, /id: memory\s+name: dsh-memory/);
for (const item of distribution.packages) {
  const pkg = readJson(`${item.directory}/package.json`);
  assert.equal(pkg.name, item.name);
  assert.equal(pkg.version, item.version);
  assert.equal(suite.dependencies[item.name], `file:./${item.file}`);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const script of ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
    assert.equal(pkg.scripts?.[script], undefined);
  }
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, item.file))).digest('hex'), item.sha256);
  for (const locale of ['en', 'zh']) {
    const meta = readJson(`${item.directory}/locale/${locale}.json`).meta;
    assert.ok(meta.title && meta.description);
  }
}
for (const [relative, expected] of Object.entries(snapshot.sha256)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, relative))).digest('hex'), expected, relative);
}
const pet = readJson('plugins/pet/package.json');
assert.equal(pet.exports['./client'].default, './lib/client.js');
assert.equal(pet.dsh.client.platform, 'web');
console.log(`Static distribution check passed: ${distribution.packages.length} independent packages; ${Object.keys(snapshot.sha256).length} copied files unchanged.`);
