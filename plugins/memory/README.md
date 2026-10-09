# Memory

独立的 `dsh-memory` Bundle，基于当前安装版 `0.1.0` 的预构建模块。此仓库版本为 `0.1.0-local.1`，包名保持 `dsh-memory`。它与 Pet 同级，可以单独安装、升级和卸载；也可以由根套件组合。

提供 `memory_write`、`memory_search`、`memory_forget` 和 `memory:recall` 提示词召回。SQLite 数据库由 [Bundle 配置](cordis.patch.yml) 指向 `$DSH_HOME/memory/memory.db`。相同 Home 会使用同一份数据；不同 Home 不自动迁移。仓库不包含数据库、用户记忆或凭据。

在 Desktop Plugins 页面可安装本目录。不要同时选择原 Memory、此独立 Bundle 和根套件，否则可能重复插入 `memory` 条目或注册工具。根套件安装流程见 [根说明](../../README.md)。

保留原来的 `@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools` peer 范围 `^0.1.0-rc.6`。目标 DSH 不满足时可能拒绝安装或激活；没有扩大范围、自动申请豁免或宣称已验证兼容。本次不运行插件测试，也不打开数据库。

原包只附带构建产物和类型声明，没有完整源码构建工具链。包声明 MIT，但未附带 LICENSE 或作者信息；许可核实仍待完成。原 README 保存在 [UPSTREAM-README.md](UPSTREAM-README.md)，其中的安装命令不是本仓库的 Desktop 安装流程。图标由本仓库原创，非上游资源。
