# Pi session-ui

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi 终端界面扩展：Claude 风格启动头（渐变 logo + 快捷键提示）、fullscreen 粘性用户消息头、Mermaid 方言渲染与圈数字规范化、`/context` 上下文占用拆分面板、底部单行状态栏、工具调用面板、工作动画、剪贴板图片紧凑粘贴与预览、`/effort` 档位切换、回合耗时，以及自动标题与会话命名。

## 快速开始

在仓库根目录执行（需 Pi 1.4.0 与 `rsync`）：

```bash
./install-harness.sh pi
```

插件装至 `~/.pi/agent/extensions/session-ui/`，重启 Pi 或执行 `/reload` 生效。

## 使用说明

### 功能与命令

| 模块 | 命令 / 交互 | 说明 |
| --- | --- | --- |
| 启动头 | 自动显示 | 官方 Pi 渐变 logo + 动态快捷键提示 + hero 文案（替换内置启动头；窄屏时上下堆叠 logo 与 hero） |
| 粘性用户消息 | 自动（fullscreen） | 用户消息滚出视口上沿后钉在顶部；单击跳回该消息 |
| Markdown 增强 | 自动 | 额外 Mermaid 方言（`sequenceDiagram`、`stateDiagram-v2` 等，经 grok-mermaid）；圈数字 `①–⑳` → `(1)–(20)`；跨行链接空白规整；本地文件链接按会话项目目录解析 |
| Markdown 图片 | `![说明](本地路径)` | 在可点击的图片说明下异步展示本地预览；默认也展开本地图片的普通链接；远程图片不下载 |
| 上下文拆分 | `/context` | 系统提示 / Memory / Skills / 工具定义 / 工具结果 / 对话 token 占用浮层；↑↓ 选择、Enter 预览（c / Tab+Enter 复制）、Esc 关闭；非 TUI 回退为 notify |
| 会话 / 子代理引用 | `@` 补全 | `@session:[…]` 注入历史会话转录；`@subagent:[…]` 提示子代理类型并要求分别委派 |
| Claude 工具卡 | `/tool-style [on\|compact\|off\|status]` | Rich Diff（bars/分栏）、连续工具分组、单击/`Ctrl+O` 展开；`compact` 折叠时只留一行摘要 |
| 专用工具卡 | 自动显示 | AskUserQuestion Q&A 树、Codemode 嵌套调用树、Subagent 完成通知 |
| Agent Summary | 自动显示 | 回合结束追加 `│ Ran 1 command, wrote 1 file · 15s`（不进 LLM 上下文） |
| Compact Thinking | 自动显示 | 思考块折叠为标题动画 + 预览 N 行；点击展开全文；完成态显示 `Thought for Xs` |
| 输入框前缀 | 自动 | Claude Code 风格 `❯` 提示符 |
| 别名 | `/clear` · `/exit` | `/clear` 开新会话；`/exit` 退出 |
| 工具活动 | 自动显示 | 输入框上方列出本轮调用（`◆` 运行中、`◇` 完成、`✗` 失败；Codemode 内部调用缩进），回合结束清空 |
| 工作动画 | `/work-animation on\|off\|status` | Working 行附带 `↓ tokens · 耗时 · avg tok/s · TTFT`；开关保存在 `~/.pi/agent/state/session-ui.json` |
| 图片粘贴与预览 | `Ctrl+V`（macOS） | 插入 `[image #1]` 标签，光标移入弹出预览（需 Kitty 或 iTerm2 图片协议；`Cmd+V` 仅粘贴文本） |
| 状态栏 | `/statusline` | 临时切换自定义单行状态栏与原生底栏 |
| 思考档位 | `/effort [level\|status]` | 无参数打开选择器，传档位名直接设置 |
| 本轮结算摘要 | 自动显示 | 每轮回复结束后显示耗时、所用模型及思考档位（如 `󰔛 4.2s · antigravity/gemini-3.8-flash (medium)`） |
| 标题与命名 | 自动 / `/name` | 复用主模型正常回复（不额外发请求）：首次明确目标时为未命名会话起名（不覆盖已有名称）；随任务变化更新终端标题；后台独立续跑不触发 |

`[查看效果](.pi/previews/result.png)` 等本地 Markdown 链接在渲染时会解析为绝对 `file://` URL，避免 fullscreen 点击后从 `/` 查找相对路径。支持绝对路径和 `~/` 路径；已有文件 URL 和网络链接保持不变。代码示例、会话存储及模型上下文不受影响。此修复仅作用于 TUI 显示，`markdownEnhance.enabled` 或 `markdownImages.enabled` 任一开启时生效，并在 `/reload` 时清理。

### Markdown 图片预览

`![效果图](.pi/previews/result.png)` 会在说明链接下展示本地 PNG/JPEG/GIF/WebP 预览；点击说明链接可用系统应用打开原图。普通 `[查看效果](本地图片.png)` 默认也会展开，包括恢复的历史消息；网页链接和非图片文件不展开。设置 `markdownImages.expandImageLinks: false` 可恢复为仅预览 `![...](...)` 图片。预览保持比例，默认不超过 60 列 × 16 行；除终端最小单元格外，不放大小图。不支持的终端/格式、文件缺失或解码失败时保留可点击说明；远程图片绝不自动下载。

通过 `markdownImages.enabled` 独立开关，`maxWidthCells`（4–160）和 `maxHeightCells`（1–40）调整上限。图片异步加载：单张限制 8 MiB / 2000 万像素，单会话最多缓存 16 个来源，每个 Markdown 块最多预览 4 张，超限仅显示链接。`/reload` 清空图片缓存，可刷新加载失败或磁盘上已替换的文件。会话存储和模型上下文不变。

### 状态栏段（Segments）

显示项与顺序由 `statusline.segments` 控制：

| ID | 内容 |
| --- | --- |
| `model` | 当前模型（窄屏缩写为模型 ID） |
| `effort` | 思考档位（`off` 时隐藏）及 `fast` 标记 |
| `directory` | 当前工作目录 |
| `branch` | Git 分支 |
| `context` | 上下文使用率与窗口大小 |
| `usage` | 订阅周期额度与重置倒计时（依赖 `pi-subscription-usage`） |
| `cache` | assistant 请求缓存命中率（`当前/最近5次/会话`） |
| `extensions` | 未被排除的其他扩展状态 |
| `tokens` | 累计输入 / 输出 token（`↑输入 ↓输出`，仓库配置默认隐藏） |
| `session` | 会话名称（默认隐藏） |

`fast` 仅代表本地已启用加速策略，详见 [Fast 说明](../fast/README.zh-CN.md)；MCP 状态用 `/mcp` 查看。

### 配置

- 默认路径：`~/.pi/agent/extensions/session-ui/config.json`（仓库源：[config.json](../../plugin-configs/session-ui/config.json)）
- 环境变量覆盖：`PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi`

修改后 `/reload` 生效。各模块（`toolActivity`、`workAnimation`、`agentSummary`、`compactThinking`、`editorPrefix`、`aliases`、`specialCards`、`compactPaste`、`claudeToolStyle`、`statusline`、`effort`、`turnSummary`、`uiMeta`、`startupHeader`、`markdownEnhance`、`markdownImages`、`contextCommand`、`reference`、`stickyUserMessage`）均默认开启，可设 `enabled: false` 关闭：

| 配置项 | 默认值 | 可选值 / 范围 |
| --- | --- | --- |
| `startupHeader.enabled` | `true` | 渐变 logo + 快捷键提示启动头 |
| `stickyUserMessage.enabled` | `true` | fullscreen 下将滚出上沿的用户消息钉在视口顶部 |
| `markdownEnhance.enabled` | `true` | Mermaid 方言 + 圈数字规范化 + 本地文件链接 |
| `markdownImages.enabled` | `true` | 本地 Markdown 图片预览；不下载远程图片 |
| `markdownImages.expandImageLinks` | `true` | 同时预览指向本地图片的普通链接 |
| `markdownImages.maxWidthCells` | `60` | 4–160 列 |
| `markdownImages.maxHeightCells` | `16` | 1–40 行 |
| `contextCommand.enabled` | `true` | `/context` 上下文占用拆分面板 |
| `reference.enabled` | `true` | `@session` / `@subagent` 引用总开关 |
| `reference.sessionReference` | `true` | `@session:[…]` 补全 + 会话转录注入 |
| `reference.subagentAutocomplete` | `true` | `@subagent:[…]` 子代理类型补全 + 委派提示 |
| `editorPrefix.enabled` | `true` | 输入框 `❯` 前缀 |
| `aliases.enabled` | `true` | `/clear`、`/exit` 别名 |
| `specialCards.enabled` | `true` | AskUser / Codemode / Subagent 专用卡 |
| `claudeToolStyle.mode` | `"on"` | `"on"` \| `"compact"` \| `"off"` |
| `claudeToolStyle.grouping` | `true` | 连续工具卡折叠为组头 |
| `claudeToolStyle.diffViewMode` | `"auto"` | `"auto"` \| `"unified"` \| `"split"` |
| `claudeToolStyle.diffIndicatorMode` | `"bars"` | `"bars"` \| `"classic"` \| `"none"` |
| `claudeToolStyle.diffSplitMinWidth` | `120` | 分栏最小终端宽度 |
| `claudeToolStyle.editDiffCollapsedLines` | `12` | 折叠态 edit diff 行数；`0` 仅摘要 |
| `claudeToolStyle.writeDiffCollapsedLines` | `8` | 折叠态 write 预览行数；`0` 仅摘要 |
| `agentSummary.enabled` | `true` | 回合结束工具统计摘要行 |
| `agentSummary.minToolCount` | `1` | 至少 N 次工具调用才输出摘要 |
| `compactThinking.enabled` | `true` | 折叠思考块为标题 + 预览 |
| `compactThinking.previewLines` | `3` | 流式中预览行数；`0` 仅标题 |
| `compactThinking.completedPreviewLines` | `1` | 完成态预览行数；`null` 跟随 previewLines |
| `workAnimation.showStats` | `true` | Working 行显示 token/耗时/速率 |
| `workAnimation.showTtft` | `true` | 速率后附带 TTFT |
| `workAnimation.tokenRateMode` | `"average"` | `"average"` \| `"live"` |
| `toolActivity.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `toolActivity.maxItems` | `6` | `1`–`20` |
| `workAnimation.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `workAnimation.intervalMs` | `180` | `100`–`500`（ms） |
| `statusline.overflow` | `"drop-right"` | `"drop-right"`（从右隐藏）\| `"priority"`（先紧凑再按优先级隐藏） |
| `statusline.segments` | 见上表默认项 | 状态段 ID 数组（整组替换并去重） |
| `statusline.extensionStatuses.exclude` | `[]` | 排除的状态 ID 数组（支持 `*` 通配符） |
| `turnSummary.showDuration` | `true` | `boolean`（是否显示本轮耗时） |
| `turnSummary.showModel` | `true` | `boolean`（是否显示本轮所用模型） |
| `turnSummary.showEffort` | `true` | `boolean`（是否显示思考档位） |
| `uiMeta.title.enabled` | `true` | `boolean` |
| `uiMeta.title.maxLength` | `36` | `8`–`80` |
| `uiMeta.sessionName.enabled` | `true` | `boolean` |
| `uiMeta.sessionName.maxLength` | `48` | `8`–`100` |
