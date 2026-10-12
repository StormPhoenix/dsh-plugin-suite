# DSH 插件集合：独立插件与源码

本仓库集中维护 DS Pet、Memory、乔木阅读与 Better Sidebar。仓库根是开发管理目录，不是 DSH Bundle。前三个插件保留原有分发结构；本次引入的 Better Sidebar 仅保存源码、测试、必要配置、文档与素材，不提交构建产物或辅助脚本，不能直接安装未构建的目录。

| 插件 | 安装目录 | 包名 | 条目 ID |
|---|---|---|---|
| DS Pet | `plugins/pet` | `dsh-pet` | `dsh-pet` |
| Memory | `plugins/memory` | `dsh-memory` | `memory` |
| 乔木阅读 | `plugins/qiaomu-reader` | `qiaomu-reader-dsh` | `qiaomu-reader` |
| Better Sidebar | `plugins/better-sidebar` | `dsh-better-sidebar` | `better-sidebar` |

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

不要选择仓库根目录，也不要用 `github:StormPhoenix/dsh-plugin-suite#main` 安装当前布局：Git 安装读取仓库根包，不能替代对子目录的分别安装。可以只安装其中一个。上述三个插件安装后在顶层列表分别显示，分别启停、卸载；Memory 不依赖桌宠，乔木阅读也不依赖前两者。

乔木阅读把 `@deepseek-ai/dsh-typert-protocol` 钉在 `0.2.0-rc.2`。在 DSH `0.2.1-alpha.1` 上插件管理器会判为不兼容，需要为该精确版本授予豁免，否则安装会被回滚。

目录安装会链接本地包，安装后不要移动或删除目录。上述三个原有插件包含预构建产物；Better Sidebar 不包含。源码更新不会自动替换已加载模块。乔木阅读保留原有重建方式，见 [UPSTREAM.md](UPSTREAM.md)。

## Better Sidebar 本地兼容版本

`0.25.0-local.1` 保留上游包名、路由和 `better-sidebar` 条目 ID，把已移除的 Host `webRuntime` 依赖替换为 `connection.requestRejection()`，由 Host 统一执行信任与认证，保留 401/403，不通过豁免绕过缺失服务。来源提交与修改摘要见 [UPSTREAM.md](UPSTREAM.md) 和 [SNAPSHOT.json](SNAPSHOT.json)。本地修复不是上游发布版本，插件市场在线更新会覆盖修复。

当前清单的 DSH devDependencies 链接相邻的 `../deepseek-harness` 已构建源码仓库；位置不同需手动调整开发依赖链接，再执行 `pnpm install --ignore-scripts`。开发时可运行 `pnpm --filter dsh-better-sidebar typecheck` 和 `pnpm --filter dsh-better-sidebar test`。需要运行插件时自行执行 `pnpm --filter dsh-better-sidebar build`；该命令直接调用 tsc 与 tsdown，生成的 `lib/` 被忽略，不提交。包清单的运行入口仍指向构建后的文件，未构建目录不是可安装包。此前 Desktop 链接到此目录；删除产物后该安装无法继续加载，应在使用前自行构建或通过管理器调整安装来源。

同名替换安装会要求完整重启，不能以当前进程显示的旧模块状态断言新版本已生效。安装前备份目标 profile 的 package.json、锁文件、配置 patch 与 compatibility.json；回滚恢复原依赖规格和配置，不会让原来依赖 `webRuntime` 的版本变得兼容。

## 从旧套件迁移

旧根 Bundle `dsh-pet` 同时挂载 Pet 和 `dsh-pet/memory`。迁移时先通过插件管理器卸载旧套件；若另有旧独立 `dsh-memory`，也先卸载，避免重复条目。完整退出 Desktop 后重新启动，再分别安装两个目录；Windows 下运行中的 Helper 可能锁定旧目录，遇到 EPERM 不要强行覆盖。替换安装后完整重启并检查状态。

迁移不删除用户数据：Pet 继续使用 `$DSH_HOME/dsh-pet/`，Memory 继续使用 `$DSH_HOME/memory/memory.db`。更改自定义数据库路径前先保留原值，不创建新的空库替代既有记忆。

## 验证与维护

```sh
node scripts/verify.mjs
node scripts/verify-rebuild.mjs
```

`verify.mjs` 仅检查三个原有分发包的独立入口、单条目 patch、客户端声明、资源与 JavaScript 语法，并检查缺失 Pet 客户端声明或入口会被拒绝。不导入插件、不打开用户数据库；静态检查不等于运行时验证。

`verify-rebuild.mjs` 保留对乔木阅读现有产物的检查，不覆盖仅存源码的 Better Sidebar：先核对已提交产物与 [SNAPSHOT.json](SNAPSHOT.json) 记录的发布摘要一致，再重新构建并逐字节比对。比对不一致时会还原已提交的产物并返回非零退出码，不留下脏工作树。运行前需在仓库根执行 `pnpm install --ignore-scripts`。

DS Pet 的聊天和碎碎念可能调用模型。Memory 提供记忆工具及上下文召回，召回内容会增加模型输入 token。乔木阅读默认在 Desktop profile 目录下的 `乔木阅读/` 维护本地书库、划线批注与阅读笔记，其 AI 伴读会调用模型。各包资源与说明见各自目录的 README。

## 来源与许可

Pet 来自 `PC2005-cloud/dsh-pet`，代码 MIT，见 [LICENSE](LICENSE)；素材再分发许可仍待核实。Memory 原包声明 MIT 但未附 LICENSE 与作者信息，公开发布前需核实。乔木阅读来自 `joeseesun/qiaomu-reader-dsh`，GPL-3.0-only，见 [plugins/qiaomu-reader/LICENSE](plugins/qiaomu-reader/LICENSE)。详见 [UPSTREAM.md](UPSTREAM.md)。当前各包保持 private，只面向本地安装。
