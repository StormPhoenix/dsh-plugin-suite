# DSH 插件集合：一个仓库，三个独立安装包

本仓库集中维护 DS Pet、Memory 与乔木阅读。仓库根是开发管理目录，不是 DSH Bundle；每个插件目录都有完整包清单、Bundle patch、运行产物和显示资源，必须分别安装。

| 插件 | 安装目录 | 包名 | 条目 ID |
|---|---|---|---|
| DS Pet | `plugins/pet` | `dsh-pet` | `dsh-pet` |
| Memory | `plugins/memory` | `dsh-memory` | `memory` |
| 乔木阅读 | `plugins/qiaomu-reader` | `qiaomu-reader-dsh` | `qiaomu-reader` |

## 按目录安装

将仓库克隆到 DSH 源码和配置 home 之外的持久目录。先在仓库根安装运行依赖并验证：

```sh
pnpm install --ignore-scripts
node scripts/verify.mjs
```

workspace 禁止自动安装 peer 依赖：DSH 的核心 peer 由 Host 运行时提供，普通 dependencies 必须在本地安装。目录链接安装不会替插件目录准备这些依赖。然后在目标 Desktop 的插件管理页面分别选择需要安装的目录，例如：

```text
G:\Workspace\dsh-plugin-suite\plugins\pet
G:\Workspace\dsh-plugin-suite\plugins\memory
G:\Workspace\dsh-plugin-suite\plugins\qiaomu-reader
```

不要选择仓库根目录，也不要用 `github:StormPhoenix/dsh-plugin-suite#main` 安装当前布局：Git 安装读取仓库根包，不能替代对子目录的分别安装。可以只安装其中一个。安装后顶层列表有三个独立包，分别启停、卸载；Memory 不依赖桌宠，乔木阅读也不依赖前两者。

乔木阅读把 `@deepseek-ai/dsh-typert-protocol` 钉在 `0.2.0-rc.2`。在 DSH `0.2.1-alpha.1` 上插件管理器会判为不兼容，需要为该精确版本授予豁免，否则安装会被回滚。

目录安装会链接本地包，安装后不要移动或删除目录。仓库包含预构建产物，使用现有版本不需要构建。后续源码更新必须更新对应构建产物并重启应用，`git pull` 不会自动替换已加载模块。乔木阅读另附完整源码与重建脚本，重建方式与字节偏差见 [UPSTREAM.md](UPSTREAM.md)。

## 从旧套件迁移

旧根 Bundle `dsh-pet` 同时挂载 Pet 和 `dsh-pet/memory`。迁移时先通过插件管理器卸载旧套件；若另有旧独立 `dsh-memory`，也先卸载，避免重复条目。完整退出 Desktop 后重新启动，再分别安装两个目录；Windows 下运行中的 Helper 可能锁定旧目录，遇到 EPERM 不要强行覆盖。替换安装后完整重启并检查状态。

迁移不删除用户数据：Pet 继续使用 `$DSH_HOME/dsh-pet/`，Memory 继续使用 `$DSH_HOME/memory/memory.db`。更改自定义数据库路径前先保留原值，不创建新的空库替代既有记忆。

## 验证与维护

```sh
node scripts/verify.mjs
```

验证检查三个包的独立入口、单条目 patch、客户端声明、资源与 JavaScript 语法，并检查缺失 Pet 客户端声明或入口会被拒绝。不导入插件、不打开用户数据库；静态检查不等于运行时验证。

DS Pet 的聊天和碎碎念可能调用模型。Memory 提供记忆工具及上下文召回，召回内容会增加模型输入 token。乔木阅读默认在 Desktop profile 目录下的 `乔木阅读/` 维护本地书库、划线批注与阅读笔记，其 AI 伴读会调用模型。各包资源与说明见各自目录的 README。

## 来源与许可

Pet 来自 `PC2005-cloud/dsh-pet`，代码 MIT，见 [LICENSE](LICENSE)；素材再分发许可仍待核实。Memory 原包声明 MIT 但未附 LICENSE 与作者信息，公开发布前需核实。乔木阅读来自 `joeseesun/qiaomu-reader-dsh`，GPL-3.0-only，见 [plugins/qiaomu-reader/LICENSE](plugins/qiaomu-reader/LICENSE)。详见 [UPSTREAM.md](UPSTREAM.md)。当前各包保持 private，只面向本地安装。
