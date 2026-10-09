# DSH 插件集合（一个 Bundle，两个平等条目）

一个 GitHub 地址安装整个套件。根包 `dsh-pet` 是一个 Bundle，[cordis.patch.yml](cordis.patch.yml) 挂载两个彼此独立的插件条目；没有 tgz、没有 `file:` 依赖、没有 monorepo 分发。

## 为什么根包叫 dsh-pet

Pet 的浏览器端模块在编译产物里把注册 id 硬编码为 `dsh-pet`，而客户端模块 id 必须等于包名。因此根包名保持 `dsh-pet`。这表示 pet 是「包」，不是「比 memory 高级」；memory 作为根包的子路径条目 `dsh-pet/memory` 加载，两者在配置、模块文件、图标和显示信息上完全平等。

## 两个条目

| 插件 | 条目 id | 模块 | 数据 | 图标 |
|---|---|---|---|---|
| DS Pet | `dsh-pet` | `dsh-pet`（根包 `.`） | `$DSH_HOME/dsh-pet/` | `plugins/pet/assets/logo.png` |
| Memory | `memory` | `dsh-pet/memory`（子路径） | `$DSH_HOME/memory/memory.db` | `plugins/memory/icon.svg` |

每个条目有独立的 id、模块文件、配置和显示信息。Pet 有浏览器端（注册为 `dsh-pet` 客户端模块）；Memory 是纯宿主插件，提供 `memory_write`、`memory_search`、`memory_forget` 和 `memory:recall`。

DSH 从 Host 入口向上寻找最近的同名包清单。`plugins/pet/package.json` 因此必须声明 `dsh.client` 与相对于 Pet 目录的 `./client` 导出，且与根清单指向同一客户端文件。`node scripts/verify.mjs` 检查两份声明一致，并验证缺失声明或入口会被拒绝。安装后，Pet 客户端在设置页面注册独立的桌宠配置条目；替换已安装版本需要完整重启 Desktop。

## 布局

```text
dsh-plugin-suite/           git 仓库根，包 dsh-pet
├── package.json            根 Bundle：exports 指向两个插件
├── cordis.patch.yml        挂载 dsh-pet 与 memory 两个条目
├── plugins/
│   ├── pet/                桌宠代码与素材（lib/runtime/assets/src）
│   └── memory/             记忆插件代码（lib）
├── scripts/verify.mjs      静态分发检查（不导入插件、不打开数据库）
└── SNAPSHOT.json            复制文件 SHA-256 清单
```

## 安装（一个地址装全部）

在目标 Desktop 的 Plugins 页面安装框输入：

```text
github:StormPhoenix/dsh-plugin-suite#main
```

固定到某个提交可改用其哈希。安装的是根 Bundle `dsh-pet`，它会同时带来 pet 和 memory 两个条目。

安装前先卸载旧的 `dsh-pet` Bundle 和旧的 `dsh-memory` Bundle，避免重复插入条目和注册工具；不要删除用户数据。安装完成后完整退出并重启 Desktop。

Memory 原包声明 peer 范围 `^0.1.0-rc.6`，但目标 DSH 0.2.x 提供的是 `0.2.x`。经比对 DSH 0.2.1-alpha.1 源码，Memory 的 `defineTool` 与 `systemPrompt.section` 调用与当前 API 一致，故套件将这两个 peer 范围更正为 `^0.2.0-rc.1`。这是基于源码核对的版本更新，不是盲目放宽；仍未做运行时加载验证，安装后如报错请保留具体日志。

## 本地单独运行与维护

克隆后也可在 Desktop Plugins 页面直接安装仓库根目录的绝对路径（目录链接，安装后不要移动）。不需要 `pnpm install` 或任何构建步骤。

```sh
node scripts/verify.mjs   # 静态检查：清单、入口语法、条目和资源
pnpm pack                 # 可选：生成根包 tarball
```

## 来源与许可

Pet 来自 `PC2005-cloud/dsh-pet`（MIT，[LICENSE](LICENSE)），其动画、字体、图片的再分发许可仍待核实。Memory 来自已安装的 `dsh-memory@0.1.0`，原包声明 MIT 但未附 LICENSE 与作者信息，公开分发前需核实。详见 [UPSTREAM.md](UPSTREAM.md)。
