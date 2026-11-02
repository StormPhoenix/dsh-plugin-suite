import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/*
 * 阅读区锚点采样/续用逻辑内嵌在 ReaderView 的大效果里，无法直接实例化；
 * 这里对 reader.js 源码做结构性断言，防止三个「侧栏开合内容漂移」缺陷回归：
 * 1. 分页模式翻页带 .18s transform 过渡，采样必须等过渡结束（setTimeout >= 200ms），
 *    否则 rAF 期间视口仍显示上一页，锚点永远落后一页，面板开合重排时整页回跳。
 * 2. 滚动模式重排修正滚动位置后必须续用锚点（写入 scrollTop），不能置 null
 *    后依赖 scroll 事件重新捕获；且清空锚点必须以「锚点不可用」为前提。
 * 3. 重排修正落页会触发一次页码变化采样，那次采样会把锚点从视线字符改成新页首，
 *    页首必然更靠前，反复开合面板就逐次倒退；必须跳过它并续用原字符。
 */
const source = await readFile(new URL('../src/ui/reader.js', import.meta.url), 'utf8');

const captureEffect = source.match(
  /const capture = \(\) => \{[\s\S]*?\n    \};\n    capture\(\);\n    const onScroll = \(\) => capture\(\);\n    viewport\?\.addEventListener\('scroll', onScroll\);/,
)?.[0];
const measureNowAnchor = source.match(
  /const anchor = textAnchorRef\.current;[\s\S]*?\/\/ The next setting action captures a fresh anchor before mutation\./,
)?.[0];

test('capture effect source is present for structural assertions', () => {
  assert.ok(captureEffect, 'capture effect must exist');
  assert.ok(measureNowAnchor, 'measureNow anchor block must exist');
});

test('paginated capture waits for the page-turn transition; scroll capture keeps rAF', () => {
  assert.match(captureEffect, /settings\.flow === 'scroll'\) \{\s*frame = requestAnimationFrame\(runCapture\);/);
  const paginatedBranch = captureEffect.match(/return;\s*\}\s*\/\*[\s\S]*?\*\/\s*timer = setTimeout\(runCapture, (\d+)\);/);
  assert.ok(paginatedBranch, 'paginated branch must defer capture with setTimeout');
  const delay = Number(paginatedBranch[1]);
  assert.ok(delay >= 200 && delay >= 180, `delay ${delay}ms must cover the 180ms transform transition`);
});

test('a reflow correction does not re-sample the anchor at the new page start', () => {
  // 修正落页后紧跟一次「页码变化」采样，跳过它，锚点才能停在原来的字符上。
  assert.match(source, /skipCaptureRef\.current = \{ page: landedPage \};/);
  assert.match(source, /const runCapture = \(\) => \{[\s\S]*?if \(liveRef\.current\.page === skip\.page\) return;/);
  assert.match(source, /\/\/ 同一个字符现在显示在新页码上：页码跟上，字符序号保持不变。\n\s+page: landedPage,/);
});

test('anchor sampling discards characters outside the current page', () => {
  assert.match(source, /const pageOf = \(left\) => visualPage \+ Math\.floor\(\(left - contentLeft \+ 1\) \/ stride\)/);
  assert.match(source, /if \(settings\.flow !== 'scroll' && pageOf\(rect\.left\) !== visualPage\) return false;/);
  // 平移量取自 inline transform，不能靠 page 状态推算，否则过渡期间算错当前页左缘。
  assert.match(source, /const shifted = Math\.abs\(parseFloat\(\/translateX/);
});

test('reflow correction only reuses an anchor sampled on the current page', () => {
  assert.match(source, /&& \(settings\.flow === 'scroll' \|\| anchor\.page === pageBefore\)/);
  assert.match(source, /const pageBefore = liveRef\.current\.page \?\? 0;/);
});

test('scroll-mode reflow correction re-arms the anchor instead of discarding it', () => {
  const scrollBranch = measureNowAnchor.match(/\} else if \(rect\) \{[\s\S]*?\n          \}\n          if \(landedPage !== null\)/)?.[0];
  assert.ok(scrollBranch, 'scroll correction branch must exist');
  assert.match(scrollBranch, /textAnchorRef\.current = \{\s*\.\.\.anchor,\s*node,\s*offset,\s*y: anchor\.y,\s*scrollTop: viewportNow\.scrollTop,/);
  // 清空锚点只允许发生在锚点完全不可用（拿不到 rect）时，不能覆盖已续用的分支。
  assert.match(measureNowAnchor, /\} else if \(!rect\) \{\s*textAnchorRef\.current = null;\s*\}/);
  assert.doesNotMatch(measureNowAnchor, /\} else \{\s*textAnchorRef\.current = null;\s*\}/);
});
