/** Rebuild every plugin that ships source and artifacts, and require the result to match what is committed. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Plugins whose committed artifacts a build must reproduce byte for byte. `build` is the script the
 * plugin's own manifest runs and `artifacts` the files it writes, both relative to the plugin
 * directory. Plugins that ship no build do not appear here.
 */
const REBUILDABLE = [
  {
    folder: 'qiaomu-reader',
    name: 'qiaomu-reader-dsh',
    build: 'scripts/build.mjs',
    artifacts: ['index.js', 'client.js'],
  },
];

const snapshot = json(resolve(root, 'SNAPSHOT.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const short = hash => hash.slice(0, 8);
const failures = [];
const line = (ok, label, detail) => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label.padEnd(11)} ${detail}\n`);
  if (!ok) failures.push(`${label.padEnd(11)} ${detail}`.trim());
};

for (const plugin of REBUILDABLE) {
  const dir = resolve(root, 'plugins', plugin.folder);
  const pkg = json(resolve(dir, 'package.json'));
  assert.equal(pkg.name, plugin.name, `${plugin.folder}: unexpected package name`);
  assert.equal(
    pkg.scripts?.build,
    `node ${plugin.build}`,
    `${plugin.name}: scripts.build must stay in sync with this table`,
  );
  process.stdout.write(`${plugin.name}\n`);
  const committed = plugin.artifacts.map(file => [file, readFileSync(resolve(dir, file))]);

  // The committed artifact is the recorded upstream file, which fixes the target for the rebuild.
  process.stdout.write('  committed artifacts against SNAPSHOT.json\n');
  for (const [file, bytes] of committed) {
    const key = `plugins/${plugin.folder}/${file}`;
    const recorded = snapshot.sha256[key];
    assert.ok(recorded, `${plugin.name}: SNAPSHOT.json records no hash for ${key}`);
    const actual = digest(bytes);
    const same = actual === recorded;
    line(same, file, same ? `matches ${short(actual)}` : `is ${short(actual)}, recorded ${short(recorded)}`);
  }

  process.stdout.write(`  rebuild with ${plugin.build}\n`);
  let built = true;
  try {
    execFileSync(process.execPath, [plugin.build], { cwd: dir, stdio: 'pipe' });
  } catch (error) {
    built = false;
    const reason = String(error.stderr || error.message).trim().split('\n').at(-1);
    failures.push(`${plugin.name}/${plugin.build} failed: ${reason}`);
    process.stdout.write(`  ✗ ${plugin.build} failed: ${reason}\n`);
  }
  // A failed build can leave a truncated artifact, and a successful one that differs must not stay
  // on disk: either way the committed bytes are restored so the check never dirties the tree.
  for (const [file, bytes] of committed) {
    const path = resolve(dir, file);
    const rebuilt = existsSync(path) ? readFileSync(path) : null;
    const same = rebuilt?.equals(bytes) === true;
    if (!same) writeFileSync(path, bytes);
    if (built) line(same, file, same ? `reproduced ${short(digest(bytes))}` : `differed, restored the committed file`);
    else if (!same) process.stdout.write(`  ·  ${file.padEnd(11)} restored the committed file\n`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nRebuild checks failed:\n${failures.map(failure => `  - ${failure}\n`).join('')}`);
  process.exitCode = 1;
} else {
  const total = REBUILDABLE.reduce((count, plugin) => count + plugin.artifacts.length, 0);
  process.stdout.write(`\nRebuild checks passed: ${total} artifacts reproduced from source.\n`);
}
