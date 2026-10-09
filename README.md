# DS Pet 本地插件仓库

本仓库是当前集成的 `dsh-pet@0.3.6-fix.3` 的预构建分发快照，测试包版本为 `0.3.6-fix.3-local.1`。根包本身就是可安装的 DSH Bundle，包含 Host、Client、Electron 桌宠运行文件和动画素材，不需要安装时编译。

## 布局

```text
package.json                 包名 dsh-pet；声明 Bundle 和 Client
cordis.patch.yml             挂载 dsh-pet 条目
lib/                        已构建的 Host / Client 和类型声明
runtime/electron-helper/    桌宠窗口实现
assets/                     动画、字体、图片和默认配置
src/                        安装包附带的源码参考
locale/                     本地测试版的中英文显示信息
scripts/verify.mjs          静态分发验证，不激活插件
SNAPSHOT.json               复制文件的 SHA-256 校验值
UPSTREAM.md                 上游与许可证说明
```

包名和条目 ID 保留为 `dsh-pet`，Client 模块也使用这个名称。仓库目录名可以改变，但不能只改包名而不修改代码中的模块标识。每个复制文件的初始摘要记录在 [SNAPSHOT.json](SNAPSHOT.json) 中。

## 在源码 Desktop 中安装

1. 从 DSH 源码仓库运行 `pnpm run start:desktop`。该命令使用已有构建产物；如果 DSH 本身还未构建，请先完成 DSH 的构建。
2. 打开 Desktop 侧栏的 Plugins 页面，通过安装功能输入这个仓库根目录的绝对路径：

   ```text
   G:\Workspace\deepseek-harness\.local\dsh-plugin-suite
   ```

3. 如果原来的 `dsh-pet` 已安装，先查看其来源并记下恢复地址。同名本地包用于替换原包；若页面拒绝重复安装，先用 Plugins 页面卸载原 Bundle，再安装本目录。不要把两个同名插件同时挂载。
4. 以管理器返回的结果判断安装和激活。替换已加载的包代码后，需要完整退出并重新运行 Desktop。
5. 确认插件行显示“DS Pet · 本地测试版”，检查宠物动画、桌面显示、拖拽和双击唤回等已有功能。桌面宠物是否显示取决于配置中宠物的 `display` 值。

本地目录安装会链接仓库目录；安装后不要移动或删除它。如果希望安装固定快照，可运行 `pnpm pack`，再在 Plugins 页面输入生成的 `.tgz` 文件的绝对路径。

普通 npm `dsh` 和源码 `pnpm dsh` 不能修改保留的 Desktop Profile。请使用 Desktop 的 Plugins 页面，不要在 Profile 目录手动运行 pnpm 或改写包清单。

源码 Desktop 默认使用 `apps/desktop/.desktop-build/development/home`，显式设置 `DSH_HOME` 时改用指定目录。正式安装版和源码开发版可能使用不同的 Home；必须在你准备测试的 Desktop 窗口里安装。

## 上传自己的 GitHub 仓库

本仓库尚未配置远端，也未上传。创建空 GitHub 仓库后，在本仓库目录执行：

```sh
git remote add origin https://github.com/YOUR-NAME/YOUR-REPO.git
git push -u origin main
git push origin v0.3.6-fix.3-local.1
```

然后在 Desktop 的 Plugins 页面输入：

```text
github:YOUR-NAME/YOUR-REPO#v0.3.6-fix.3-local.1
```

构建产物和素材已提交到 Git；保留它们才能直接从 Git 安装。本包没有 prepare、prepack 或安装生命周期脚本，但依赖包的脚本许可是另一回事：如果管理器报告待批准脚本，先确认其用途再允许。Host 代码和获准的脚本以宿主权限运行。

## 验证与限制

```sh
node scripts/verify.mjs
pnpm pack
```

验证脚本检查快照摘要、关键入口语法、Bundle 声明、显示资源和动画文件。它不导入插件，不调用模型，也不验证实际 Desktop 显示效果。

源码目录是安装包附带的参考，不保证与当前安装的修补产物完全同步。此快照没有完整的源码构建工具链，不能直接把修改 `src/` 当作运行代码更新。需要开发新功能时，应先补齐可复现的构建流程，再同时更新 Host、Client 或桌宠相关产物和快照摘要。

保留上游 DSH peerDependencies；兼容检查由目标 DSH 运行时执行，本仓库未声明所有 DSH 版本均兼容。宠物的碎碎念、聊天等功能可能调用模型；安装不会主动重写用户配置，也不会复制凭据、对话记忆或用户目录。

## 将来增加其他插件

不独立发布时，可在本根包中增加插件模块，并在根补丁中增加唯一的条目 ID。纯 Host 插件可使用包子路径导出。新增 Client 插件还必须处理模块注册标识和 Client 分发配置，不能仅添加目录。需要独立安装、升级和卸载时，应转为多包仓库并分别发布可安装包。

## 来源与许可

上游为 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，保留其 [MIT 许可证](LICENSE)。[UPSTREAM.md](UPSTREAM.md) 记录本快照的来源与分发修改。附带图标沿用上游原图，本仓库不把它描述为新创作素材；上传公开仓库前应确认动画、字体和图像的再分发许可。
