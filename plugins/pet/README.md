# DS Pet

本目录是可独立安装的 `dsh-pet` Bundle，只挂载桌宠条目。通过目标 Desktop 插件管理页面选择本目录安装，不选择仓库根目录。目录安装后必须保留本目录。

包包含预构建 Host、Client、Electron Helper 和动画素材；客户端模块 ID 为 `dsh-pet`，包清单声明同名客户端入口，设置页面提供桌宠配置。启停和卸载不会控制 Memory。

默认配置在 [config.jsonc](assets/config.jsonc)，用户配置与聊天记忆保存在 `$DSH_HOME/dsh-pet/`。聊天与碎碎念可能调用模型；禁用相应功能可停止对应请求。迁移安装不删除用户数据。

附带源码不保证与现有构建产物同步。Windows 双击激活依赖协同升级后的插件与 Desktop：Desktop 必须提供自身的 `DSH_DESKTOP_WINDOW_ACTIVATION_PID`，旧版仅提供能力标记时激活不可用。`koffi` 声明为 `optionalDependencies`；缺失或无法加载其原生模块时，仅停用窗口激活，桌宠其他功能仍可使用。升级本目录的构建产物与 Desktop 后，完全退出并重启 Desktop；源码修改需重新构建，刷新页面不足以生效。替换运行中的 Helper 文件可能报 EPERM，需退出 Desktop 后重试。受支持 Windows 矩阵的真实原生激活尚待验证。来源与许可见 [来源说明](../../UPSTREAM.md)。
