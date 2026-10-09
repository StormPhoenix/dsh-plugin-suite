# DS Pet

独立的 `dsh-pet` Bundle，包含当前安装版 `0.3.6-fix.3` 的预构建 Host、Client、桌宠运行文件和动画。此仓库分发版本为 `0.3.6-fix.3-local.3`。包名和 Client 模块标识保持 `dsh-pet`，搬入子目录不会改变它的身份。

在 Desktop 的 Plugins 页面可以单独安装本目录，或安装根套件组合；不要同时选择两个插入同一个 `dsh-pet` 条目的 Bundle。本地目录安装后不能移动目录。安装与迁移流程见 [根说明](../../README.md)。

默认配置在 [config.jsonc](assets/config.jsonc)，用户配置与聊天记忆由插件在目标 DSH Home 下管理，不随仓库分发。宠物显示受 `display` 等配置控制；碎碎念、聊天可能调用模型。运行代码与原安装包保持相同，本次不进行行为测试。

包仅分发运行需要的 WebM 动画，预览 GIF 仍保留在仓库但不进入插件 tarball。附带源码不保证与修补后的构建产物完全同步；没有完整源码构建工具链，改源码不等于产物已更新。

图标和素材沿用上游资源；MIT 声明见 [LICENSE](LICENSE)，上游与素材许可限制见 [来源说明](../../UPSTREAM.md)。
