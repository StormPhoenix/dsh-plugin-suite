# 来源与许可

## Pet

上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。MIT 声明见 [LICENSE](LICENSE)。本仓库不含上游 Git 历史。

运行代码、素材与附带源码来自已安装的 `dsh-pet@0.3.6-fix.3`，复制后仅迁移目录，字节未改。子路径 `plugins/pet/` 下的 `lib`、`runtime`、`assets`、`src`、`scripts/ensure-electron.mjs` 为复制原文件，摘要见 [SNAPSHOT.json](SNAPSHOT.json)。图标、动画、字体和图片沿用原包，公开发布前应核实素材再分发条件；预览 GIF 保留在仓库但不影响安装。

## Memory

来自已安装的 `dsh-memory@0.1.0`。`plugins/memory/lib/index.js`、`index.d.ts` 为复制原文件，字节未改。配置路径仍为 `$DSH_HOME/memory/memory.db`，本仓库不包含数据库或记忆正文。

原包声明 MIT，但未附 LICENSE、作者或仓库信息。原 README 保存在 [plugins/memory/UPSTREAM-README.md](plugins/memory/UPSTREAM-README.md)，其中的安装命令不适用于本仓库。不虚构作者，完整许可仍待确认。Memory 图标为本仓库原创。

原包 peer 声明为 `dsh-tools@^0.1.0-rc.6`、`dsh-system-prompt@^0.1.0-rc.6`。本套件将其更正为 `^0.2.0-rc.1`，依据是对 DSH 0.2.1-alpha.1 源码的比对：`defineTool`（`output.schema`/`output.render`/`output.presentationMeta`/`presentCall`）与 `systemPrompt.section` 的调用方式与当前 API 一致。运行代码本身未改动，仅 peer 声明更新。

## Qiaomu Reader

上游项目：[joeseesun/qiaomu-reader-dsh](https://github.com/joeseesun/qiaomu-reader-dsh)，GPL-3.0-only，许可见 [plugins/qiaomu-reader/LICENSE](plugins/qiaomu-reader/LICENSE)。该包为 `private: true`，不发布 npm；公开产物只有 v1.0.2 的 Release 包 `qiaomu-reader-dsh-1.0.2.tgz`（sha256 `2932a2567b8c0fc2cccc3bd17e0635cc8d6a862e9e45c4ae1040ee008c683cf0`）。

复制来源是上游提交 `1a640ee6a7d914200fa69733a68df829f41bd4b5`（tag `v1.0.2`），也就是该 Release 指向的提交。复制时排除 `.git`、`node_modules`、`package-lock.json` 与 `.github`，其余文件字节未改，摘要见 [SNAPSHOT.json](SNAPSHOT.json)。`src/client/ui` 是上游入库的符号链接（git 模式 120000），按原样保留。`index.js`（`39f6fcb9…c978`）与 `client.js`（`2058c5ff…95dcf`）与上游提交和 Release 包内的同名文件逐字节相同。

手改五处：

- `package.json` 增加 `exports["./cordis.patch.yml"]`，与套件其余插件一致。
- `package.json` 删除 `prepack` 脚本。套件禁止任何安装期脚本，本仓库也不打包发布；`npm run check`（build + test + verify-package）仍可手动使用。
- `package.json` 把 `dependencies.pdfjs-dist` 由 `^6.2.108` 收窄为精确 `6.2.108`。原因不是版本偏好：客户端产物把 pdf.js 内联进 `client.js`（`src/client/pdf-book.js` 导入它），宿主半在运行时外部解析同一个包，范围声明会让两半装上不同版本。
- `locale/{en,zh}.json` 增加 `meta.title` / `meta.description`。DSH 从 `./locale/*.json` 读取插件显示名与描述，缺失时标题回退为包名；原有扁平键未动，界面文案在代码中注册（`src/ui/library-locale.js`），构建不读取这两个文件。
- `scripts/build.mjs` 的客户端构建增加 `preserveSymlinks: true`。pnpm 把依赖装成符号链接，esbuild 默认解析到 `.pnpm` 下的真实路径，产物里的依赖路径注释就会带上 store 路径；保留链接路径后，本仓库的重建结果与上游发布包逐字节一致。不开该选项时两者只差 4 处依赖路径字符串，被内联的代码本身相同。

重建：仓库根执行 `pnpm install --ignore-scripts`，再到 `plugins/qiaomu-reader` 运行 `node scripts/build.mjs`。在本仓库的 pnpm 隔离布局下，`index.js` 与 `client.js` 都逐字节重现发布包；上游 `npm test` 的 47 项测试在该副本上通过。该属性由仓库根的 `node scripts/verify-rebuild.mjs` 持续校验：它先比对 [SNAPSHOT.json](SNAPSHOT.json) 记录的摘要，再重建比对，不一致即失败并还原已提交的产物。

## 集合

仓库根包名 `dsh-plugin-suite-workspace`，是 workspace 管理目录而非 DSH Bundle，不代表也不承担任何上游的版权归属；`dsh-pet` 这一插件包名是保留 Pet 浏览器模块 id 的技术要求。各插件的依赖、兼容声明与许可相互独立，每个包的来源（已安装包或上游提交）记在 [SNAPSHOT.json](SNAPSHOT.json) 的 `sources`。复制原文件摘要见同一文件的 `sha256`，手改的清单、locale、图标与 README 不纳入该清单。
