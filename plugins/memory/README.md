# Memory

本目录是可独立安装的 `dsh-memory` Bundle，只挂载 `memory` 条目，不依赖 Pet。通过目标 Desktop 插件管理页面选择本目录安装；目录安装后必须保留本目录。没有浏览器客户端或独立设置侧栏页。

提供 `memory_write`、`memory_search`、`memory_forget` 和 `memory:recall`。SQLite 数据库路径由本目录 [cordis.patch.yml](cordis.patch.yml) 指向 `$DSH_HOME/memory/memory.db`，沿用旧套件路径；仓库不包含数据库、用户记忆或凭据。召回会将选中记忆加入模型输入，增加输入 token，不自行发起模型请求。

预构建代码沿用 `0.1.0`，工具和系统提示 peer 范围为 `^0.2.0-rc.1`。迁移前卸载旧套件或旧独立 Memory，避免重复条目；不要删除数据库。自定义数据库路径应原样保留。

原包声明 MIT 但未附 LICENSE 与作者信息，公开发布前需核实；原文见 [UPSTREAM-README.md](UPSTREAM-README.md)，其安装命令不适用于本仓库。图标为本仓库原创。
