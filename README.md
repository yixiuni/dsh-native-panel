# DSH Native Panel for VS Code 🐳

在 VS Code 右侧栏里运行**真实的 DeepSeek Harness Web 界面**，并把 DSH 每轮的文件改动映射成 VS Code **原生并排 diff**；同时把编辑器的活动文件/选区自动带进对话。

> 这是 [Fengze233/dsh-vscode](https://github.com/Fengze233/dsh-vscode)（MIT）的修改版：移除了「在 webview 里重写一套 UI」的路线，保留真实 DSH 页面，并补上编辑器原生能力。

## 功能

- **真实 DSH 界面**：右侧栏 webview 里嵌的是 DSH 自己的页面（对话/轨迹、模型选择、审批卡、思考动画都是原样），不是重写。
- **原生 diff**：点状态栏 `DSH 改动`（或命令 `DSH: 打开本轮改动 diff`），把最近一轮 `write`/`edit` 的改动还原成改动前内容，用 VS Code 原生并排 diff 打开；右侧就是磁盘上的真实文件。
- **自动编辑器上下文**：活动文件 + 选区会随消息自动注入 `<ide_context>`（文件路径、行号范围、选区代码），不用手动复制。
- **右键菜单**：`添加选区到 DSH`、`添加文件到 DSH`，用于额外补充上下文。
- **自动服务管理**：自动启动或复用 `dsh web`，处理 DSH ≥0.1.2 的令牌/会话 cookie，只监听回环地址。
- **只保留右侧面板**：视图固定在辅助侧边栏（secondary sidebar），不再占用左侧活动栏。

## 构建与安装

需要 VS Code ≥ 1.91、Node ≥ 20，以及本机可用的 `dsh`（DSH Desktop 自带的即可）。

```bash
npm ci
npm run compile
npx vsce package --allow-missing-repository -o dsh-native.vsix
code --install-extension dsh-native.vsix --force
```

安装后重新加载窗口，点编辑器标题栏的鲸鱼图标打开右侧 DSH 面板。

## 配置

| 设置 | 说明 |
|---|---|
| `dsh.executablePath` | `dsh` 可执行文件的绝对路径；PATH 里没有 `dsh` 时（例如只用 Desktop）建议显式指定 |
| `dsh.profile` / `dsh.host` / `dsh.port` | 启动的 profile 与监听地址，默认 `web` / `127.0.0.1` / `3080` |
| `dsh.stopOnExit` | 关闭 VS Code 时是否停掉自启的 dsh（默认 `true`） |
| `dsh.workspaceRootIndex` | 多根工作区取第几个根目录 |

## 已知边界

- diff 只对**当前 runtime 进程记录过**的轮次有效：DSH 的改动对比保存在 Host 内存里，runtime 重启后历史轮次没有对比。
- 二进制、超过 2 MB、已删除的文件不会生成 diff；一轮最多打开前 8 个文件。
- 自动上下文对每条消息都会注入；选区超过 200 行或 8 KB 时只带「路径 + 行号」。
- 审批前预览 diff 尚未实现。
- 桥接脚本由扩展在启动时安装进 DSH profile（`$DSH_HOME/profiles/<profile>/node_modules/dsh-vscode-bridge`），用于文件链接、剪贴板和上下文注入。

## 结构

| 路径 | 职责 |
|---|---|
| `src/panel/` | webview 与 iframe 中继（握手、消息路由、占位页） |
| `src/service/` | dsh 进程管理、鉴权会话、本地代办代理、启动网址解析 |
| `src/nativeDiff/` | 会话日志扫描、改动摘要/diff 请求、hunk 反向还原、原生 diff |
| `bridge-client/` | 注入到 DSH 页面的桥接客户端（`insertText` / `setIdeContext` / 文件与外链转发） |

## 许可

MIT。基于 [Fengze233/dsh-vscode](https://github.com/Fengze233/dsh-vscode) 修改；DeepSeek Harness 归 DeepSeek 所有。
