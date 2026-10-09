# 来源与许可

## Pet

上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。MIT 声明见 [LICENSE](LICENSE)。本仓库不含上游 Git 历史。

运行代码、素材与附带源码来自已安装的 `dsh-pet@0.3.6-fix.3`，复制后仅迁移目录，字节未改。子路径 `plugins/pet/` 下的 `lib`、`runtime`、`assets`、`src`、`scripts/ensure-electron.mjs` 为复制原文件，摘要见 [SNAPSHOT.json](SNAPSHOT.json)。图标、动画、字体和图片沿用原包，公开发布前应核实素材再分发条件；预览 GIF 保留在仓库但不影响安装。

## Memory

来自已安装的 `dsh-memory@0.1.0`。`plugins/memory/lib/index.js`、`index.d.ts` 为复制原文件，字节未改。配置路径仍为 `$DSH_HOME/memory/memory.db`，本仓库不包含数据库或记忆正文。

原包声明 MIT，但未附 LICENSE、作者或仓库信息。原 README 保存在 [plugins/memory/UPSTREAM-README.md](plugins/memory/UPSTREAM-README.md)，其中的安装命令不适用于本仓库。不虚构作者，完整许可仍待确认。Memory 图标为本仓库原创。

## 集合

根包名 `dsh-pet` 是保留 Pet 浏览器模块 id 的技术要求，不代表版权归属。根包不承担 Pet 或 Memory 上游的版权；各插件的依赖、兼容声明与数据归属保持独立。复制原文件摘要见 [SNAPSHOT.json](SNAPSHOT.json)，手改的清单、locale、图标与 README 不纳入该清单。
