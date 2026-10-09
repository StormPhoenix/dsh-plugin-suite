/** Check independent installation manifests, resources and syntax without activating plugins. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

/** Scripts a plugin must never declare: installing it must not execute its code. */
const FORBIDDEN_SCRIPTS = ['prepare', 'prepack', 'preinstall', 'install', 'postinstall'];

/** The entry an export declares, from either its string form or its conditions object. */
const exportTarget = value => typeof value === 'string' ? value : value?.default;

/**
 * Every plugin this repository distributes on its own: the directory holding it, the package and
 * Bundle row names it must carry, the entry files its manifest must export, and any check only its
 * own distribution form needs. Only these targets are pinned; the layout underneath them is the
 * upstream package's own.
 */
const PLUGINS = [
  {
    folder: 'pet',
    name: 'dsh-pet',
    id: 'dsh-pet',
    entry: './lib/index.js',
    client: { entry: './lib/client.js', moduleId: 'dsh-pet' },
    extra: ({ pkg, client, checkClient }) => {
      const missingDeclaration = structuredClone(pkg);
      delete missingDeclaration.dsh.client;
      assert.throws(() => checkClient(missingDeclaration, client));
      const missingEntry = structuredClone(pkg);
      delete missingEntry.exports['./client'];
      assert.throws(() => checkClient(missingEntry, client));
    },
  },
  {
    folder: 'memory',
    name: 'dsh-memory',
    id: 'memory',
    entry: './lib/index.js',
    extra: ({ patch }) => {
      assert.match(patch, /path: !!js dshHomePath\('memory\/memory\.db'\)/);
    },
  },
];

/** A web plugin exposes its client half at the declared entry, on no other platform. */
function checkClient(pkg, client) {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(exportTarget(pkg.exports?.['./client']), client.entry);
}

/** Every declared target stays inside the package and, unless it is a wildcard, exists. */
function checkExportTargets(dir, pkg) {
  for (const value of Object.values(pkg.exports)) {
    for (const target of typeof value === 'string' ? [value] : Object.values(value)) {
      assert.ok(target.startsWith('./') && !target.includes('..'), target);
      if (!target.includes('*')) assert.ok(existsSync(resolve(dir, target)), target);
    }
  }
}

/** A declared dependency must be installed, or the plugin loads only after a second install step. */
function checkDeclaredDependencies(dir, pkg) {
  const require = createRequire(resolve(dir, 'package.json'));
  for (const [kind, declared] of [['runtime', pkg.dependencies], ['development', pkg.devDependencies]]) {
    for (const dependency of Object.keys(declared ?? {})) {
      try {
        require.resolve(dependency);
      } catch {
        // The resolution error only names a path; this states the one action that fixes it.
        assert.fail(`Missing ${kind} dependency: ${dependency}; run pnpm install at repository root`);
      }
    }
  }
}

/** The Bundle row inserts exactly this plugin, under this id, once. */
function checkPatch(dir, plugin) {
  const patch = readFileSync(resolve(dir, 'cordis.patch.yml'), 'utf8');
  assert.equal((patch.match(/\bid:/g) ?? []).length, 1);
  assert.match(patch, new RegExp(`id: ${plugin.id}\\s+name: ['"]?${plugin.name}['"]?(?:\\s|$)`));
  assert.doesNotMatch(patch, /dsh-pet\/memory/);
  return patch;
}

/** Both dictionaries carry the display metadata the distribution requires. */
function checkLocaleMeta(dir) {
  for (const language of ['en', 'zh']) {
    const meta = json(resolve(dir, 'locale', `${language}.json`)).meta;
    assert.ok(meta.title && meta.description);
  }
}

/** Parse every entry with the running Node before anything loads it. */
function checkSyntax(dir, entries) {
  for (const entry of entries) {
    const result = spawnSync(process.execPath, ['--check', resolve(dir, entry)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0);
  }
}

assert.equal(json(resolve(root, 'package.json')).dsh, undefined);
for (const plugin of PLUGINS) {
  const dir = resolve(root, 'plugins', plugin.folder);
  const pkg = json(resolve(dir, 'package.json'));
  assert.equal(pkg.name, plugin.name);
  checkDeclaredDependencies(dir, pkg);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  for (const script of FORBIDDEN_SCRIPTS) assert.equal(pkg.scripts?.[script], undefined);
  checkExportTargets(dir, pkg);
  const entry = exportTarget(pkg.exports['.']);
  assert.equal(entry, plugin.entry);
  assert.ok(resolve(dir, entry).startsWith(dir + sep), `${plugin.folder}: entry must stay inside the package`);
  const patch = checkPatch(dir, plugin);
  checkLocaleMeta(dir);
  checkSyntax(dir, plugin.client ? [plugin.entry, plugin.client.entry] : [plugin.entry]);
  if (plugin.client) {
    checkClient(pkg, plugin.client);
    assert.match(readFileSync(resolve(dir, plugin.client.entry), 'utf8'), new RegExp(`id: "${plugin.client.moduleId}"`));
  } else {
    assert.equal(pkg.dsh.client, undefined);
  }
  plugin.extra?.({ dir, pkg, patch, client: plugin.client, checkClient });
}
console.log(`Distribution checks passed: ${PLUGINS.length} independent Bundles (${PLUGINS.map(plugin => plugin.name).join(', ')}).`);
