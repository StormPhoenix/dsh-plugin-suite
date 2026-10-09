#!/usr/bin/env node
/**
 * 客户端产物核验器。
 *
 * 做两件事：
 *   1. 语法与依赖解析：把 `src/client/index.js` 真正打包一遍（react 之外全内联），
 *      任何 import 路径错误、导出名错误、语法错误都会在这里暴露。
 *   2. 外壳契约：确认产物是 `window.__ModuleLoader__.load({ id, factory })` 形式，
 *      且只外部化平台种子表里的 react——绝不能 require 任何 `@deepseek-ai/*` 包。
 *
 * 之所以独立成脚本：它可以**在没有 UI 层时**用内存 stub 代替真实模块，
 * 从而在任何阶段都能验证「集成层能否被打包」，而不必等所有队友交付。
 *
 * 用法：node scripts/check-client.mjs [--stub-ui]
 */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_ID = 'qiaomu-reader-dsh';

/** 内存 stub：UI 层尚未交付时替身，字段与真实契约一致。 */
const UI_STUB = {
  name: 'qmr-ui-stub',
  setup(pluginBuild) {
    const stub = `
      import * as React from 'react';
      export function ReaderOverlay() { return React.createElement('div', null, 'stub'); }
      export function createUiStore(initial) {
        let state = initial;
        const listeners = new Set();
        return {
          get: () => state,
          set: (patch) => { state = { ...state, ...patch }; for (const fn of [...listeners]) fn(); },
          subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
          select: (fn) => fn(state),
        };
      }
    `;
    pluginBuild.onResolve({ filter: /\.\.\/ui\// }, (args) => ({ path: args.path, namespace: 'qmr-stub' }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'qmr-stub' }, () => ({ contents: stub, loader: 'js' }));
  },
};

function moduleLoaderShell(body) {
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(CLIENT_ID)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    (function (module, exports, require) {
${body}
    })(module, exports, require);
    return module.exports;
  },
});
`;
}

async function main() {
  const result = await build({
    entryPoints: [path.join(ROOT, 'src/client/index.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome120'],
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
    write: false,
    logLevel: 'warning',
    plugins: [UI_STUB],
  });

  const raw = result.outputFiles?.[0]?.text ?? '';
  const shell = moduleLoaderShell(raw);

  const forbid = [...shell.matchAll(/require\("(@deepseek-ai\/[^"]+)"\)/g)].map((match) => match[1]);
  const requires = [...new Set([...shell.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))];

  const checks = [
    ['打包成功且产物非空', shell.length > 1000],
    ['使用 __ModuleLoader__.load 外壳', shell.includes('__ModuleLoader__.load(')],
    [`外壳 id 为 ${CLIENT_ID}`, shell.includes(`id: "${CLIENT_ID}"`)],
    ['外部依赖只有 react 家族', requires.every((name) => name === 'react' || name === 'react/jsx-runtime' || name === 'react-dom' || name === 'react-dom/client')],
    ['没有 require 任何 @deepseek-ai/* 包', forbid.length === 0],
    // esbuild 的 CJS 输出用 getter 定义导出（__export + apply: () => apply），
    // 所以匹配方式不能只认 `exports.apply =`。
    ['导出 apply', /\bapply\b\s*[:=]/.test(shell) && /exports/.test(shell)],
    ['导出 inject', /\binject\b\s*[:=]/.test(shell) && /exports/.test(shell)],
  ];

  process.stdout.write('\n客户端产物核验（内存构建，不落盘）：\n');
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  }
  process.stdout.write(`\n  外部 require：${requires.join(', ') || '（无）'}\n`);
  process.stdout.write(`  打包体积：${(shell.length / 1024).toFixed(1)} KiB\n`);
  if (forbid.length > 0) process.stdout.write(`  违规依赖：${forbid.join(', ')}\n`);

  if (failed > 0) {
    process.stderr.write(`\n核验未通过（${failed} 项）。\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n核验通过。\n');
}

main().catch((error) => {
  process.stderr.write(`核验失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});