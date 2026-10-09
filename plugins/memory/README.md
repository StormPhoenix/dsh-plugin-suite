# Memory

本目录承载 `memory` 条目：预构建的宿主插件（`lib/index.js`、`lib/index.d.ts`）。它作为根 Bundle `dsh-pet` 的子路径 `dsh-pet/memory` 加载，与 Pet 平等，不是 Pet 的附属模块。

提供 `memory_write`、`memory_search`、`memory_forget` 和 `memory:recall`。SQLite 数据库指向 `$DSH_HOME/memory/memory.db`（见根 [cordis.patch.yml](../../cordis.patch.yml)）。仓库不包含数据库、用户记忆或凭据。

原包声明 MIT 但未附 LICENSE 与作者信息，公开分发前需核实；原 README 保存在 [UPSTREAM-README.md](UPSTREAM-README.md)，其中安装命令不适用于本仓库。图标为本仓库原创。运行代码与安装版 `0.1.0` 字节一致，本次不做行为测试。
