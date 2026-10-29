# DS Pet

本目录是可独立安装的 `dsh-pet` Bundle，只挂载桌宠条目。通过目标 Desktop 插件管理页面选择本目录安装，不选择仓库根目录。目录安装后必须保留本目录。

包包含预构建 Host、Client、Electron Helper 和动画素材；客户端模块 ID 为 `dsh-pet`，包清单声明同名客户端入口，设置页面提供桌宠配置。启停和卸载不会控制 Memory。

当前内容同步自上游 `PC2005-cloud/dsh-pet` 的 `v0.3.8`（commit `593b9b0`），套件版本号为 `0.3.8-local.1`。

默认配置在 [config.jsonc](assets/config.jsonc)，用户配置、聊天记忆与桌宠素材保存在 `$DSH_HOME/dsh-pet/`。聊天与碎碎念可能调用模型；禁用相应功能可停止对应请求。迁移安装不删除用户数据。

## 相对上游的定制

只有一处行为定制：**双击桌宠本体 = 唤起 DSH Desktop**（把主窗口叫回前台；未运行时由 `dsh://` 协议拉起应用）。

实现落在 `runtime/electron-helper/sprite.js`：`click` 监听加 `e.detail < 2` 守卫（双击第二下不再重复播点击动画），并注册 `dblclick` 交给 `onOpenDsh()`，复用上游已有的 `pet:open-site` 通道——桌面形态下主进程执行 `shell.openExternal('dsh://open')`。因此双击与上游自带的 `Ctrl/Cmd + 左键`、右键菜单「打开软件」走同一条路径，不额外维护 IPC 与方法。

拖拽或拖拽刚结束（`justDragged` 100ms 冷却）时不触发，避免抢占上游「双击第二下按住拖 = 弹弓」的手势。

早期版本还带过 Windows 原生前台授权链（`koffi` + `pet:activate-desktop` + Host 关联 IPC）。同步到 `v0.3.8` 后已整体移除：`dsh://open` 的协议唤起在 macOS 上已验证，Windows 若出现「窗口已唤起但不置前」，再按需补回仅 `win32` 的最小授权分支。

## 构建

产物（`lib/`、`runtime/electron-helper/shared-core.js`）随包提交，日常安装不需要构建。修改源码后在仓库根执行 `pnpm install --ignore-scripts`，再在本目录执行：

```sh
pnpm run build          # tsdown（lib/）+ scripts/build-desktop-core.mjs（shared-core.js）
pnpm run lint
pnpm run test           # 只有 src/shared 的用例能在本布局跑通，见下
```

套件 workspace 关闭了 peer 自动安装（`autoInstallPeers: false`），因此两件事必须在具备 DSH 依赖的环境（上游 clone）里做，不在本目录重跑：

- `pnpm run types`（`scripts/gen-types.mjs`）与上游 `scripts/prepare.js` 的发布链生成 `lib/types/`，需要 `@deepseek-ai/*` 的类型声明；
- `src/host`、`src/standalone` 的测试会 import 这些 peer 包，缺包时直接 `ERR_MODULE_NOT_FOUND`。

`shared-core.js` 由 `src/shared/` 生成，不要手改。升级本目录的构建产物后需完全退出并重启 Desktop；刷新页面不足以生效（Host 与 Helper 都是独立进程）。替换运行中的 Helper 文件可能报 EPERM，退出 Desktop 后重试。来源与许可见 [来源说明](../../UPSTREAM.md)。
