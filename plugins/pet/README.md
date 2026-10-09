# DS Pet

本目录是可独立安装的 `dsh-pet` Bundle，只挂载桌宠条目。通过目标 Desktop 插件管理页面选择本目录安装，不选择仓库根目录。目录安装后必须保留本目录。

包包含预构建 Host、Client、Electron Helper 和动画素材；客户端模块 ID 为 `dsh-pet`，包清单声明同名客户端入口，设置页面提供桌宠配置。启停和卸载不会控制 Memory。

默认配置在 [config.jsonc](assets/config.jsonc)，用户配置与聊天记忆保存在 `$DSH_HOME/dsh-pet/`。聊天与碎碎念可能调用模型；禁用相应功能可停止对应请求。迁移安装不删除用户数据。

附带源码不保证与现有构建产物同步。Windows 双击激活功能依赖修复版 Host/Desktop IPC；没有该能力的 DSH 不支持这一功能。替换运行中的 Helper 文件可能报 EPERM，需退出 Desktop 后重试。来源与许可见 [来源说明](../../UPSTREAM.md)。
