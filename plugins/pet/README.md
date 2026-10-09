# DS Pet

本目录承载 `dsh-pet` 条目：预构建的 Host（`lib/index.js`）、Client（`lib/client.js`）、桌宠运行文件（`runtime/`）和动画素材（`assets/`）。这是根 Bundle `dsh-pet` 的 `.` 导出，客户端模块注册 id 保持 `dsh-pet`。

默认配置在 [config.jsonc](assets/config.jsonc)，用户配置与聊天记忆由插件在 `$DSH_HOME/dsh-pet/` 下管理，不随仓库分发。碎碎念与聊天可能调用模型。运行代码与安装版 `0.3.6-fix.3` 字节一致，本次不做行为测试。

预览 GIF 保留在仓库但不参与安装；附带源码不保证与构建产物同步。图标和素材沿用上游，许可见 [来源说明](../../UPSTREAM.md)。
