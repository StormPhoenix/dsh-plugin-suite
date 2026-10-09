# Memory

本目录承载 `memory` 条目：预构建的宿主插件（`lib/index.js`、`lib/index.d.ts`）。它作为根 Bundle `dsh-pet` 的子路径 `dsh-pet/memory` 加载，与 Pet 平等，不是 Pet 的附属模块。

提供 `memory_write`、`memory_search`、`memory_forget` 和 `memory:recall`。SQLite 数据库指向 `$DSH_HOME/memory/memory.db`（见根 [cordis.patch.yml](../../cordis.patch.yml)）。仓库不包含数据库、用户记忆或凭据。

原包声明 MIT 但未附 LICENSE 与作者信息，公开分发前需核实；原 README 保存在 [UPSTREAM-README.md](UPSTREAM-README.md)，其中安装命令不适用于本仓库。图标为本仓库原创。运行代码与安装版 `0.1.0` 字节一致。

原包 peer 声明为 `dsh-tools@^0.1.0-rc.6`、`dsh-system-prompt@^0.1.0-rc.6`，与 DSH 0.2.x 提供的版本不匹配。经比对 0.2.1-alpha.1 源码，本插件的 `defineTool`（含 `output.schema`/`output.render`/`output.presentationMeta`/`presentCall`）与 `ctx.systemPrompt.section()` 用法和当前 API 一致，根套件因此将这两个 peer 更正为 `^0.2.0-rc.1`。未做运行时加载验证。
