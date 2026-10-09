# 来源与许可

## DS Pet

上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。MIT 版权声明保留在根 [LICENSE](LICENSE)。本仓库不包含上游 Git 历史，也不是 GitHub fork。

快照来自当前 Inspect 返回的已安装 `dsh-pet@0.3.6-fix.3`。Pet 的运行代码、素材和附带源码保持原样；未复制 Profile、node_modules、用户配置、缓存、凭据或会话。图标、动画、字体和图片沿用原包；公开发布前须核实第三方素材的再分发条件。

## Memory

快照来自当前 Inspect 返回的已安装 `dsh-memory@0.1.0`。复制其构建模块、类型声明、README 和原补丁；构建模块字节保持原样。其子目录包清单移除缺失的构建工具链和安装生命周期脚本，作为嵌入根包的 ESM 模块目录，不作为独立 Bundle 自动选择。

原包声明 MIT，但未附带 LICENSE 或作者、仓库信息。原 README 保留于 [Memory 原说明](plugins/memory/README.md)；其中命令和开发指引不是本套件的安装流程。没有凭空补写 Memory 的版权归属；公开分发前须确认其完整许可。本仓库原创的 [Memory 图标](plugins/memory/icon.svg) 按根 MIT 许可证提供。

根套件加入 Memory 的依赖和原始 DSH peer 范围，没有扩大其兼容声明。根补丁保留 `$DSH_HOME/memory/memory.db` 路径，不复制数据库，也不运行插件。

## 分发版本

`0.3.6-fix.3-local.2` 在 Pet 快照上加入 Memory 子路径导出、根配置条目、显示信息和分发清单。摘要见 [SNAPSHOT.json](SNAPSHOT.json)。此次没有进行安装、运行测试或推送；原 Pet-only 标签保留不变。
