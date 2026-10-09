# DSH 本地插件套件

一个 Git 仓库、一个根 Bundle，包含 DS Pet 与 Memory 两个插件。当前套件版本为 `0.3.6-fix.3-local.2`；本次 Memory 添加仅整理文件和配置，未安装、未运行测试。

## 插件与布局

| 插件 | 来源版本 | 根 Bundle 挂载名 | 条目 ID |
|---|---|---|---|
| DS Pet | `dsh-pet@0.3.6-fix.3` 已安装包 | `dsh-pet` | `dsh-pet` |
| Memory | `dsh-memory@0.1.0` 已安装包 | `dsh-pet/memory` | `memory` |

```text
package.json                 根包仍名为 dsh-pet；导出 Pet 与 Memory
cordis.patch.yml             同时插入两个插件条目
lib/                        Pet 的预构建 Host / Client
runtime/electron-helper/    Pet 桌宠窗口实现
assets/                     Pet 动画、字体、图片和默认配置
src/                        Pet 安装包附带的源码参考
plugins/memory/lib/         Memory 预构建模块及类型声明
plugins/memory/locale/      Memory 显示信息
plugins/memory/icon.svg     本仓库原创 Memory 图标
plugins/memory/README.md    安装包附带的原说明，仅作上游参考
locale/                     根 Bundle / Pet 显示信息
SNAPSHOT.json               复制文件的 SHA-256 校验值
UPSTREAM.md                 来源与许可证说明
```

根包保留 `dsh-pet` 名称，因为 Pet 的 Client 模块以该名称注册。Memory 使用同一根包的子路径导出，由根补丁加载；它的子目录不是独立安装包，根依赖清单负责提供其运行依赖。两个插件可以分别禁用，但包的安装、升级和卸载仍是一起进行。

## Memory 行为与配置

Memory 提供 `memory_write`、`memory_search`、`memory_forget`，并通过 `memory:recall` 提示词段带入置顶和最近记忆。存储为本地 SQLite FTS5，不使用 embedding 服务。

根补丁保留其原始部署参数：

```yaml
- insert:
    - id: memory
      name: dsh-pet/memory
      config:
        path: !!js dshHomePath('memory/memory.db')
        promptRecentCount: 10
        promptMaxChars: 2000
        maxTextChars: 2000
        searchLimitDefault: 10
        searchLimitMax: 50
        promptOrder: 50
```

这里仅展示根补丁中的 Memory 条目，不要再把它作为第二份补丁插入。数据库位于目标运行时的 `$DSH_HOME/memory/memory.db`；相同 Home 可读到已有记忆，不同 Home 不自动迁移。本仓库不包含用户数据库、记忆正文、凭据或会话。以后启用插件会打开或创建该数据库，并让召回内容进入模型上下文。

## 兼容性与许可限制

Memory 原包声明 `@deepseek-ai/dsh-system-prompt` 和 `@deepseek-ai/dsh-tools` 的 peer 范围为 `^0.1.0-rc.6`，根套件保留该要求。若目标 DSH 版本不满足，整个套件可能在安装阶段被拒绝。未测试前不扩大版本范围，也不自动申请版本豁免。

Memory 已安装包声明 MIT，但不含 LICENSE、作者或仓库地址。本仓库保留其包清单声明和原 README，不凭空补写版权归属。公开分发 Memory 前，应确认其完整许可证与来源。本次修改未推送。

Pet 源码是安装包附带的参考，不保证与修补产物完全同步；Memory 没有附带源码和构建配置。两者均使用预构建产物，修改源码不等于运行代码已经更新。

## 以后在源码 Desktop 中安装

1. 从 DSH 源码仓库运行 `pnpm run start:desktop`，打开 Desktop 的 Plugins 页面。
2. 记录已有 `dsh-pet` 与 `dsh-memory` 的来源，再手动卸载旧 Bundle，防止重复的 `memory` 条目和工具注册。不要删除记忆数据库。
3. 安装本地仓库根目录：

   ```text
   G:\Workspace\deepseek-harness\.local\dsh-plugin-suite
   ```

4. 查看兼容性及激活结果；替换包代码后完整退出并重启 Desktop。
5. 后续再验证两个条目和各自功能。本次尚未进行此步骤。

本地目录安装链接仓库目录，安装后不要移动它。普通 npm `dsh` 和源码 `pnpm dsh` 不能修改 Desktop Profile，请通过目标 Desktop 的 Plugins 页面管理。

源码 Desktop 默认 Home 为 `apps/desktop/.desktop-build/development/home`，显式 `DSH_HOME` 会替换该目录。源码版和正式安装版可能使用不同 Home。

## GitHub 与版本

远端为 [StormPhoenix/dsh-plugin-suite](https://github.com/StormPhoenix/dsh-plugin-suite)。已推送的 `v0.3.6-fix.3-local.1` 是 Pet-only 版本，不含 Memory。本次 local.2 修改只在本地；完成兼容性与分发确认后，再提交新版本并推送。旧标签不移动。

旧的 `.tgz` 也是 Pet-only，不能用于安装新套件。后续生成新包或发布新标签时使用新版本，不覆盖旧文件。

## 后续验证命令

```sh
node scripts/verify.mjs
pnpm pack
```

这些命令本次未运行。验证脚本仅检查快照、入口语法、声明和资源，不激活插件，也不验证 Desktop 显示。本包没有安装期构建脚本；依赖脚本的许可仍需另行确认。Host 插件及获准脚本在宿主权限下执行。

## 扩展套件

以后增加纯 Host 插件，可继续放在 `plugins/`，增加根导出、运行依赖和唯一的插件条目。新增 Client 插件还需处理模块注册和 Client 分发，不是只添加目录。需要各插件独立安装或升级时，应转为多包发布。

详细来源说明见 [UPSTREAM.md](UPSTREAM.md)，快照清单见 [SNAPSHOT.json](SNAPSHOT.json)。
