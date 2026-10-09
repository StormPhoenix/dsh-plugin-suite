#!/usr/bin/env node
/**
 * 构建乔木阅读 DSH 插件的两半产物：
 *
 *   index.js   宿主半：Cordis 插件（Node ESM），只把 dsh 自带包保持为 external。
 *   client.js  客户端半：浏览器懒加载 CJS 模块，React 走平台种子表，其余全部内联。
 *
 * 客户端产物的外壳必须是 `window.__ModuleLoader__.load({ id, factory(require) })`：
 * DSH 的模块系统以「工厂返回 exports」的惰性 CJS 协议加载插件，不能是 ESM。
 * 用法：node scripts/build.mjs [--dev]
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_ID = 'qiaomu-reader-dsh';
const STAGE = path.join(ROOT, 'build');

const dev = process.argv.includes('--dev');
/** 引导构建：用 /tmp/qmr-bootstrap 里的桩件替换 UI 层，只为先验证安装与 Slot 注册。 */
const bootstrap = process.argv.includes('--bootstrap');
const BOOTSTRAP_DIR = '/tmp/qmr-bootstrap';

/** 宿主半的 external：由 dsh 安装目录解析，不打进产物。 */
const HOST_EXTERNAL = [
  'pdfjs-dist',
  'pdfjs-dist/*',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tools/*',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-typert-protocol',
];

/** 客户端半的 external：只有平台种子表里的模块可以外部化，其余必须内联。 */
const CLIENT_EXTERNAL = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];

/** 引导模式的替换插件：把 ../ui/* 映射到桩目录。 */
const bootstrapPlugin = {
  name: 'qmr-bootstrap-ui',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.\.\/ui\// }, (args) => {
      const name = path.basename(args.path);
      return { path: path.join(BOOTSTRAP_DIR, name), namespace: 'qmr-bootstrap' };
    });
    pluginBuild.onLoad({ filter: /.*/, namespace: 'qmr-bootstrap' }, async (args) => {
      try {
        return { contents: await readFile(args.path, 'utf8'), loader: 'js' };
      } catch {
        return {
          contents: 'export default function Missing() { return null; } export function ReaderOverlay() { return null; } export function createUiStore() { const s = {}; return { get: () => s, set: () => {}, subscribe: () => () => {}, select: (f) => f(s) }; }',
          loader: 'js',
        };
      }
    });
  },
};

/** 把 esbuild 的 CJS 产物包进 DSH 的懒加载工厂外壳。 */
function moduleLoaderShell(body) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    (function (module, exports, require) {
${body}
    })(module, exports, require);
    return module.exports;
  },
});
`;
}

async function buildHost() {
  await build({
    entryPoints: [path.join(ROOT, 'src/host/index.js')],
    outfile: path.join(ROOT, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: HOST_EXTERNAL,
    legalComments: 'none',
    logLevel: 'info',
    banner: { js: '/* 乔木阅读 · 宿主半 — 由 scripts/build.mjs 生成，请勿手改。 */' },
    sourcemap: dev,
  });
  // 去掉产物里的 JSDoc 块注释：产物是可执行文件，不需要文档注释，
  // 也避免注释被宿主的配置投影误读。
  if (!dev) {
    const file = path.join(ROOT, 'index.js');
    const withComments = await readFile(file, 'utf8');
    const stripped = withComments.replace(/\/\*\*(?:(?!\*\/)[\s\S])*?\*\//g, '');
    if (stripped.length !== withComments.length) await writeFile(file, stripped, 'utf8');
  }
}

async function buildClient() {
  await mkdir(STAGE, { recursive: true });
  const entry = path.join(STAGE, 'client-entry.js');
  const raw = path.join(STAGE, 'client.raw.cjs');
  await writeFile(
    entry,
    [
      '/* 客户端半的 esbuild 入口：重新导出 src/client/index.js 的公开接口。 */',
      "export * from '../src/client/index.js';",
      '',
    ].join('\n'),
    'utf8',
  );
  // 第一步：打成自包含的 CJS（平台 React 模块之外全部内联）。
  await build({
    entryPoints: [entry],
    outfile: raw,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: CLIENT_EXTERNAL,
    legalComments: 'none',
    logLevel: 'warning',
    loader: { '.css': 'text' },
    sourcemap: false,
    plugins: bootstrap ? [bootstrapPlugin] : [],
  });
  // 第二步：包进 DSH 懒加载工厂外壳。分两步做是为了确定性——
  // 不再依赖 esbuild 插件钩子与写盘的时序。
  // 剥掉可能存在的 sourceMappingURL：外壳里的注释行会失效，留着只会让
  // 浏览器去 404 一个不存在的 map。
  const body = (await readFile(raw, 'utf8')).replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  await writeFile(path.join(ROOT, 'client.js'), moduleLoaderShell(body), 'utf8');
}

async function summary() {
  const client = await readFile(path.join(ROOT, 'client.js'), 'utf8');
  const host = await readFile(path.join(ROOT, 'index.js'), 'utf8');
  const check = (label, ok) => process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  process.stdout.write('\n产物自检：\n');
  check(`index.js 导出 apply()`, /export\s*\{[^}]*\bapply\b/.test(host) || /export function apply/.test(host));
  check(`index.js 导出 inject`, /export\s*\{[^}]*\binject\b/.test(host) || /export const inject/.test(host));
  check(`client.js 使用 __ModuleLoader__.load`, client.includes('__ModuleLoader__.load('));
  check(`client.js 注册 id 为 ${CLIENT_ID}`, client.includes(`id: "${CLIENT_ID}"`));
  check('client.js 不外部化 DSH 服务模块', !/require\("@deepseek-ai/.test(client));
  process.stdout.write(`\n  index.js  ${host.length.toLocaleString()} 字节\n  client.js ${client.length.toLocaleString()} 字节\n`);
}

async function main() {
  process.stdout.write('构建 乔木阅读 (qiaomu-reader-dsh)\n');
  await rm(STAGE, { recursive: true, force: true });
  await buildHost();
  await buildClient();
  await rm(STAGE, { recursive: true, force: true });
  await summary();
  process.stdout.write(`\n完成${dev ? '（开发模式，含 sourcemap）' : ''}。\n`);
}

main().catch((error) => {
  process.stderr.write(`构建失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
