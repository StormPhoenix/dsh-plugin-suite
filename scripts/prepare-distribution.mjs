/** Pack independent plugin snapshots for Git-hosted suite installation. No plugin code is imported. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pnpm = process.env.DSH_SUITE_PNPM_ENTRY || process.env.npm_execpath;
if (!pnpm) throw new Error('Run through pnpm run release:prepare, or set DSH_SUITE_PNPM_ENTRY to pnpm.mjs.');
const suite = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
mkdirSync(resolve(root, 'dist'), { recursive: true });
const packages = [];
for (const directory of ['pet', 'memory']) {
  const packageRoot = resolve(root, 'plugins', directory);
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  if (suite.dependencies[pkg.name] !== `file:./dist/${filename}`) {
    throw new Error(`Update root dependency for ${pkg.name} before packing.`);
  }
  const result = spawnSync(process.execPath, [pnpm, 'pack', '--out', resolve(root, 'dist', filename)], {
    cwd: packageRoot, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Packing ${pkg.name} failed: ${result.status}`);
  packages.push({
    name: pkg.name, version: pkg.version, directory: `plugins/${directory}`,
    file: `dist/${filename}`,
    sha256: createHash('sha256').update(readFileSync(resolve(root, 'dist', filename))).digest('hex')
  });
}
writeFileSync(resolve(root, 'dist/manifest.json'), JSON.stringify({ suiteVersion: suite.version, packages }, null, 2) + '\n');
console.log('Distribution prepared. Commit plugin changes, tarballs, and dist/manifest.json together.');
