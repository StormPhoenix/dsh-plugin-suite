# DSH 插件集合

统一收集、管理独立的 DSH 插件。Pet 和 Memory 位于同级目录，各有自己的包名、版本、依赖、Bundle 声明与显示资源。根包 `dsh-plugin-suite@0.1.0-local.1` 只负责可选的整套安装，不是任何插件的实现。

## 布局与身份

```text
dsh-plugin-suite/
├── package.json              根组合 Bundle：dsh-plugin-suite
├── pnpm-workspace.yaml       统一管理 plugins/*
├── cordis.patch.yml          明确组合两个插件
├── plugins/
│   ├── pet/                  独立包 dsh-pet
│   │   ├── package.json
│   │   ├── cordis.patch.yml
│   │   ├── lib/
│   │   ├── runtime/
│   │   └── assets/
│   └── memory/               独立包 dsh-memory
│       ├── package.json
│       ├── cordis.patch.yml
│       └── lib/
├── dist/                     提交到 Git 的独立插件 tarball
│   └── manifest.json         版本、路径和 SHA-256
├── scripts/                  分发准备与静态检查
└── SNAPSHOT.json              原始复制文件的摘要
```

| 插件 | 独立包名 | 当前分发版本 | 配置条目 ID |
|---|---|---|---|
| [Pet](plugins/pet/README.md) | `dsh-pet` | `0.3.6-fix.3-local.3` | `dsh-pet` |
| [Memory](plugins/memory/README.md) | `dsh-memory` | `0.1.0-local.1` | `memory` |

Pet 的 Client 标识仍为 `dsh-pet`，移动目录不改变注册名。Memory 不再作为 `dsh-pet/memory` 子路径加载，而是使用自己的包名。根包没有 Client 导出或 Client 声明。

## 整套安装如何分发

根包通过 `file:./dist/<包名>-<版本>.tgz` 依赖两个独立包；根补丁明确挂载 `dsh-pet` 与 `dsh-memory`。子包 tarball 随根包和 Git 仓库分发，安装时不构建源码，也不依赖 pnpm 把未经发布的 `workspace:*` 自动转换。

工作目录保留所有 Pet 素材，但分发 tarball 只包含播放需要的 WebM，预览 GIF 不进入 tarball。每个文件均小于 GitHub 普通 Git 单文件限制；不要把包含预览 GIF 的旧大压缩包提交到 Git。

准备分发文件后需将子包改动、根依赖版本、tarball 和 [dist/manifest.json](dist/manifest.json) 一起提交。升级一个插件不强制改变另一个插件的版本。根 tarball 只含组合配置、元数据和两个子包 tarball，不再次包含整个插件源码树。

## 在源码 Desktop 安装

普通 npm `dsh` 或源码 `pnpm dsh` 不能修改 Desktop Profile，请在目标 Desktop 的 Plugins 页面安装。

### 整套安装

1. 运行 `pnpm run start:desktop`，打开 Plugins 页面。
2. 先记录原 Pet、Memory 或旧套件的来源。卸载旧的 `dsh-pet` 根 Bundle 和原 `dsh-memory` Bundle，避免重复配置条目、工具和数据库连接。不要删除用户数据库或宠物配置。
3. 本地安装输入仓库根目录：

   ```text
   G:\Workspace\deepseek-harness\.local\dsh-plugin-suite
   ```

4. 发布本次重构后，GitHub 安装输入：

   ```text
   github:StormPhoenix/dsh-plugin-suite#main
   ```

5. 查看兼容与激活结果；替换代码后完整退出并重启 Desktop。

本次重构尚未推送；远端 main 暂时仍是之前的布局。旧标签 `v0.3.6-fix.3-local.1` 不移动，也不是新结构。

### 单独安装

本地 Plugins 页面可以只安装其中一个包目录：

```text
G:\Workspace\deepseek-harness\.local\dsh-plugin-suite\plugins\pet
G:\Workspace\deepseek-harness\.local\dsh-plugin-suite\plugins\memory
```

也可以输入对应 dist tarball 的绝对路径。目录安装会链接目录，安装后不要移动它。通过整套安装得到的依赖不是独立选中的 Bundle；需要独立管理时使用单独安装路径。不要同时选择独立插件 Bundle 和插入相同条目的根套件。

## 数据、兼容性与许可

Memory 的原始配置路径仍为 `$DSH_HOME/memory/memory.db`；同一 Home 使用同一数据，不同 Home 不自动迁移。此仓库不包含数据库、记忆正文、凭据或会话。启用 Memory 时会打开或创建数据库，并把召回内容加入模型上下文。

源码 Desktop 默认 Home 为 `apps/desktop/.desktop-build/development/home`，显式 `DSH_HOME` 会替换它。正式安装版与源码版可能使用不同 Home。

Memory 保留原 DSH peers `^0.1.0-rc.6`，目标 DSH 可能拒绝安装或启动；根包不设伪造的统一范围来绕过子包检查。没有扩大兼容范围或申请豁免。Pet 的碎碎念和聊天可能调用模型。

Pet 和 Memory 都是安装包快照，不是已经验证可重建的源码 fork。Pet 附带参考源码但可能与修补产物不同步；Memory 未附带源码工具链。修改参考源码不等于运行代码已更新。

Pet 的 MIT 文件在 [Pet LICENSE](plugins/pet/LICENSE)，素材的独立许可仍需核实。Memory 原包只声明 MIT，缺少完整 LICENSE 与作者信息，公开分发许可仍待确认。根组合没有借用 Pet 作者作为整个集合的版权人。详细来源见 [UPSTREAM.md](UPSTREAM.md)。

## 维护命令

```sh
pnpm run release:prepare
pnpm run verify
pnpm pack
```

`release:prepare` 使用 pnpm 打包两个子包并生成摘要，不安装依赖或导入插件；`verify` 只核对声明和文件摘要，不运行行为测试或打开数据库；`pnpm pack` 生成可选的根包。脚本没有挂到 prepare、install 等生命周期，Git 安装使用已提交的 dist 文件。依赖脚本权限仍由安装者单独确认，Host 插件和获准脚本在宿主权限下运行。

## 新增插件

将新插件放在 `plugins/<名称>/`，保留它独立的包名、依赖和 Bundle 配置。需要加入整套时，在分发脚本的包列表、根依赖和根补丁中增加对应条目，再生成 dist。新增 Client 插件也保持自身模块名和 Client 声明；根包不承接其 Client 身份。
