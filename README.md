# Harness Configurations (pi-config)

统一管理和分发 AI 编码代理（Agent Harness）配置文件的仓库，当前已初始化 **Pi** 的基础最小配置，并预留了公共插件与自定义扩展的接入规范。

---

## 目录结构

```text
.
├── harnesses/
│   └── pi/
│       ├── config/
│       │   ├── settings.json         # Pi 核心全局配置（最小基础集）
│       │   └── keybindings.json      # 常用按键映射（Vim 风格滚动等）
│       ├── plugin-configs/           # 插件专属配置文件
│       │   ├── pi-fff/config.json    # Fast File Finder 配置（覆盖模式、禁用 Home 深度扫描）
│       │   ├── web-search/config.json# 网页检索配置（auto-summary、代理/SSRF网段）
│       │   └── session-ui/config.json# 状态栏段项定制（模型、耗时、目录、分支、用量等）
│       ├── extensions/               # 本地自定义扩展存放目录
│       │   ├── session-ui/           # 状态栏/回合结算/紧凑粘贴/UI元数据增强插件
│       │   ├── provider-quota/       # 多 Provider 订阅配额与速率限制监控插件
│       │   └── .gitkeep
│       ├── themes/                   # 自定义主题目录
│       │   ├── claude-dark.json      # Claude Code 风格深色主题（去底色、低噪思考文本）
│       │   └── claude-light.json     # Claude Code 风格浅色主题
│       └── models.example.json       # 模型端点与参数覆盖模板
├── rules/
│   └── AGENTS.md                     # 全局通用 Agent 执行规则（提示词/操作边界）
├── install-harness.sh                # 部署/软链接同步脚本（支持备份与 dry-run）
├── .gitignore                        # 忽略凭据（auth.json）、会话及运行时缓存
├── LICENSE
└── README.md
```

---

## 基础最小配置说明

### 1. 核心设置 (`harnesses/pi/config/settings.json`)

基础最小配置保持纯净，不预装重型插件，专注于提供可靠舒适的终端交互与工具底座：

- **模型与推理默认项**：
  - `defaultProvider: "antigravity"`：默认使用 Antigravity 提供商。
  - `defaultModel: "gemini-3.8-flash"`：默认启动模型。
  - `defaultThinkingLevel: "medium"`：默认思考推理级别。
  - `enabledModels`：快捷轮换与启用的模型列表（包含 gemini-3.8-flash、gemini-4-argon、deepseek 系列及 cursor/default）。
- **编辑器与界面**：
  - `theme: "claude-light/claude-dark"`：Claude Code 风格自适应主题（浅色/深色终端自动切换，去除用户输入沉重色块，微弱弱化思考文本）。
  - `tuiMode: "fullscreen"`：全屏交互界面。
  - `fullscreenScrollbar: "auto"`：自适应显示滚动条。
  - `showHardwareCursor: true`：启用硬件光标，优化终端输入法支持。
  - `externalEditor: "nvim"`：使用 Neovim 作为外部编辑器。
  - `collapseChangelog: true`：更新后折叠更新日志。
- **运行交互与上下文**：
  - `steeringMode: "all"` / `followUpMode: "all"`：连续交互与全量投递模式。
  - `treeFilterMode: "no-tools"`：精简会话树视图。
  - `compaction.keepRecentTokens: 80000`：自动压缩时保留充足的最近对话上下文。
- **工具基座**：
  - `defaultTools: ["+codemode"]`：在内置读写编辑工具基础上默认启用 `codemode` 代码沙箱工具。
- **扩展包 (`packages`)**：
  - `npm:pi-web-access`：网络检索与实时网页内容抓取。
  - `npm:@juicesharp/rpiv-ask-user-question`：结构化向用户澄清需求与选项问答。
  - `git:github.com/badlogic/pi-subagent`：独立子代理（Subagent）并行协作与任务委派。
  - `npm:@ff-labs/pi-fff`：高性能模糊文件搜索（Fast File Finder）。
  - `npm:pi-cursor-sdk`：Cursor 接口与模型支持。
  - `npm:pi-antigravity`：Antigravity 模型接入支持。
  - `npm:@sentiolabs/pi-frontend-design`：高质感前端设计辅助插件。
- **自定义插件 (`extensions`)**：
  - `session-ui`：全功能 UI 增强扩展（包含定制状态栏 Statusline、回合结算摘要 Turn-Summary、紧凑粘贴 Compact-Paste、工具执行动效 Work-Animation、会话元数据控制器等）。
  - `provider-quota`：多 Provider 订阅配额与重置倒计时监控扩展（微内核调度器 + 插件化 Adapters 架构，对接 Antigravity、OpenAI/GPT、Claude、Grok 等）。

### 2. 键位映射 (`harnesses/pi/config/keybindings.json`)

针对全屏终端交互，配置了符合直觉的 Vim/终端滚动快捷键：

- `tui.altScreen.pageUp`：`pageUp` / `alt+k`
- `tui.altScreen.pageDown`：`pageDown` / `alt+j`
- `tui.altScreen.top`：`home` / `alt+,`
- `tui.altScreen.bottom`：`end` / `alt+.`

### 3. 插件专属配置 (`harnesses/pi/plugin-configs/`)

参考历史配置，仅保留当前已启用及常用的有价值配置，过滤掉无用/已停用的部分：

- **`pi-fff/config.json`**（对应 `npm:@ff-labs/pi-fff`）：
  - 映射目标：`~/.pi/agent/pi-fff.json`
  - 设置 `mode: "override"`，由 fff 替换内置 find/grep；关闭 `enableHomeDirScanning` 防止在 `$HOME` 误触发超大树扫描。
- **`web-search/config.json`**（对应 `npm:pi-web-access`）：
  - 映射目标：`~/.pi/agent/web-search.json`
  - 设置 `workflow: "auto-summary"`、搜索模型 `gemini-3.8-flash`，并开放 `198.18.0.0/15` 网段支持 TUN/Fake-IP 代理防 SSRF 误拦截。
- **`session-ui/config.json`**（对应状态栏与会话扩展）：
  - 映射目标：`~/.pi/agent/extensions/session-ui/config.json`
  - 精选 statusline 显示段：`model`, `effort`, `directory`, `branch`, `context`, `usage`, `cache`, `extensions`。
- **过滤掉的部分**：
  - `claude-bridge`：当前环境未接入该插件。
  - `fast`：历史上已显式设置 `"enabled": false` 停用。

### 4. 全局规则 (`rules/AGENTS.md`)

基于历史规则进行精炼与强化，规范 Agent 交互与工程实践边界：
- **需求澄清**：禁止随意反问已知信息；关键分歧一次性聚合提问并提供合理预设或选项。
- **任务三模式**：
  - **咨询/审查**：严格只读，给出具体文件/行号及判断依据；
  - **故障排查**：因果证据闭环，不把“下一步排查”甩给用户，简洁只限制输出不限制调查深度；
  - **实施任务**：聚焦当前目标，局部精准替换，避免盲目重写全文件，改动伴随自我验证。
- **运行环境规范**：
  - Docker 优先；常用基础镜像固定清晰 tag（如 `golang:1.26-alpine`、`node:26-alpine`、`alpine:3.24` 等），严禁 `latest`；
  - 启动进程严格管理前台生命周期，严禁僵尸进程；
  - 严禁未经授权安装全局宿主工具（如 `brew`、全局 `npm` 等），污染可溯源。
- **基本边界**：破坏性操作严格授权；注释与 commit message 默认英文；明确区分【已确认事实】、【推测假设】与【未验证风险】。

### 5. 模型模板 (`harnesses/pi/models.example.json`)

提供了自定义 OpenAI 兼容接口、模型参数与上下文覆盖配置的范例模板，正式使用时可复制到目标 agent 目录下的 `models.json` 中配置 API Key。

---

## 安装与同步

仓库根目录提供了 `install-harness.sh` 脚本，将配置文件安全软链接至本地代理目录（默认为 `~/.pi/agent` 或 `$PI_CODING_AGENT_DIR`）：

### 1. 预览改动（Dry Run）
```bash
./install-harness.sh --dry-run
```

### 2. 执行软链接部署
```bash
./install-harness.sh
```
> **安全机制**：如果目标目录已有同名文件且不是软链接，脚本会自动生成 `.bak.<时间戳>` 备份文件，不会破坏已有历史数据。

### 3. 复制模式（非软链接）
```bash
./install-harness.sh -m copy
```

---

## 下一步规划

1. **引入公共插件（npm / git packages）**：
   在 `settings.json` 的 `packages` 字段中添加通用的成熟插件（例如网络检索、交互式询问确认、子代理编排等）。
2. **沉淀自定义插件（extensions）**：
   在 `harnesses/pi/extensions/` 中开发与维护个性化扩展功能，并由 `install-harness.sh` 统一挂载。
