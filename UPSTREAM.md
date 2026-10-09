# 来源与许可

## Pet

上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。原 MIT 声明位于 [plugins/pet/LICENSE](plugins/pet/LICENSE)，不代表集合中其他插件的版权归属。本仓库不含上游 Git 历史。

快照来自已安装 `dsh-pet@0.3.6-fix.3`。Pet 的运行代码、素材和附带源码保持复制时的字节，仅迁移目录。其独立包版本为 `0.3.6-fix.3-local.3`，包名和 Client 模块名均保留 `dsh-pet`。tarball 不分发仅供展示的预览 GIF，仓库仍保留它们。

图标、动画、字体和图片沿用原包，公开发布前应核实素材再分发条件。未复制用户配置、缓存、凭据或会话。

## Memory

快照来自已安装 `dsh-memory@0.1.0`。构建模块和类型字节保持原样。独立包版本为 `0.1.0-local.1`，保留 `dsh-memory` 包名和 `memory` 配置条目。配置路径仍是 `$DSH_HOME/memory/memory.db`，未复制数据库。

原包声明 MIT，但未附 LICENSE 或作者、仓库信息。原说明保存在 [Memory 原 README](plugins/memory/UPSTREAM-README.md)。不虚构作者或补写未知版权声明，完整许可仍待确认。Memory 图标为本仓库新绘制资源。

## 集合

根 `dsh-plugin-suite@0.1.0-local.1` 仅组合独立包，提供新的根图标与显示信息。各插件的依赖、兼容声明、许可证与用户数据归属保持独立。没有扩大 DSH peer 范围，没有安装或激活插件。

复制文件的原始摘要按新目录记录在 [SNAPSHOT.json](SNAPSHOT.json)，分发 tarball 摘要在 [dist/manifest.json](dist/manifest.json)。根包依赖提交到 Git 的子包 tarball，避免安装时依赖缺失的源码工具链。旧标签保持不变。
