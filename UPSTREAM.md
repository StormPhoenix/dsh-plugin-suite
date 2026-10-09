# 上游与快照来源

上游项目：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。上游 MIT 版权声明保留在 [LICENSE](LICENSE)。本仓库是独立本地 Git 仓库，不包含上游 Git 历史，也不是已在 GitHub 建立的 fork。

快照取自当前 DSH Inspect 返回的已安装 `dsh-pet` 包，原版本为 `0.3.6-fix.3`。保留原包内的 `lib/`、`src/`、`runtime/`、`assets/` 以及 Electron 下载辅助脚本；摘要见 [SNAPSHOT.json](SNAPSHOT.json)。未复制 Profile、node_modules、用户配置、缓存、凭据或会话。

本地分发版本为 `0.3.6-fix.3-local.1`。分发修改包括精简包清单、移除缺失工具链对应的构建脚本和独立运行 bin、移除未经本次验证的商城兼容记录、增加本地测试版显示信息、根补丁、安装说明和验证脚本。不修改复制的宠物运行代码或素材。

图标、动画、字体和图片沿用上游包中的资源。包的 MIT 声明不替代第三方素材的单独授权；本快照仅用于本地测试，公开发布前须核实附带资源的再分发条件。
