# repo-cache-manager

基于 **Subagent 物理隔离 + 项目扫描缓存挂载** 的 Pi 插件。

## 核心原则
- **绝对不调用 `setModel()`**：插件绝不自动切换或篡改当前主会话模型。主会话永远保持用户选择的模型，天然保障主模型 100% 的 KV Cache 命中率。
- **物理隔离，跑完即焚**：全量代码扫描（`scout`）与架构规划（`architect`）分别在独立的子进程会话中运行，使用只读权限，单轮结束立即清理。
- **按需挂载，智能保护**：默认仅在重模型（Argon、Carbon、Astra、Fable）回合把架构摘要挂进 system prompt；轻量模型回合不注入，避免摘要税。切模型时仍对巨型 tool 输出脱水。

---

## 模块构成

### 1. 专用 Subagent 工具
- **`scout` (代码库侦察兵)**
  - 绑定模型：`antigravity/gemini-3.8-flash`
  - 权限：仅限只读工具（`read, grep, find, ls`）
  - 职责：独立子会话扫描项目结构、核心入口与接口签名，将 2000 Tokens 以内的高密度架构摘要写入工作区 `.pi/scan-cache.json`（含当前 `git rev-parse HEAD`），并仅将摘要返回给主会话。
- **`architect` (顶层架构师)**
  - 绑定模型：`antigravity/gemini-4-argon`
  - 权限：只读/纯推理，严禁调用 `write` / `edit`
  - 职责：在跨模块重构或复杂设计时，将【`.pi/scan-cache.json` 摘要 + 核心代码片段 + 需求描述】（严格控制在 5K Tokens 内）传给独立子会话，单轮输出精确到文件路径、函数签名和修改步骤的 `<task_spec>` 并返回给主会话。

### 2. 状态检测与提示词挂载 (`before_agent_start`)
对比当前 `git rev-parse HEAD` 与 `git status --porcelain` 变更文件数。注入策略由 `injectRepoCacheOn` 控制（默认 `"heavy"`）：
- **轻量模型 / `deferred`**：不写入 `repo_cache` section（0 摘要税）；磁盘缓存仍保留，供切到重模型时使用。
- **重模型 + `SCANNED`**：注入 `.pi/scan-cache.json` 摘要（及少量 dirty 文件名）。
- **重模型 + `UNSCANNED`**：提示调用 `scout` 建索引。
- `"always"` / `"never"`：可强制每轮注入或永不注入。

### 3. 跨模型上下文保护 (`context` 钩子)
- **同模型持续对话**：100% 保持原始消息列表一字不改，确保云端 KV Cache 持续命中。
- **手动切换模型**：当检测到跨模型切换时，仅将切换模型前累积的巨型 `role === "toolResult"` 原始文件读取输出替换为简短占位符（头部已有 2K 架构摘要），防止新模型（如 Argon / Opus）触发数万 Token 的全价重算。

### 4. 全链路缓存遥测（Telemetry）
在 `before_agent_start` → `context` → `before_provider_request` → `message_update` / `message_end` → `turn_end` 采集 5 类指标；**每轮结束默认输出**【单轮缓存审计卡片】（不计入 LLM 上下文的 `repo-cache-audit` session entry，TUI 可展开）：

1. **注入与前缀指纹**：`repoCacheStatus`、`sysPromptHash`（变化标 `⚠️ SYS_MUTATED`）、`prefixLocked`（`🔒 LOCKED` / `💥 BUSTED at msg[i]`）
2. **本地脱水效果**：`rawEstTokens` vs `sentEstTokens`、`omittedTools` 与节省比例
3. **云端 API 账单**：`input` / `cacheRead` / `cacheWrite` / `output`，以及 `cloudCacheHitRate = cacheRead / (input + cacheRead)`
4. **隐性思考剖析**：优先用 provider `usage.reasoning`，否则用 `visibleChars / 3.5` 估算 `thinkingTokens`
5. **耗时与窗口水位**：`ttftMs` / `totalDurationMs`，以及 `ctx.getContextUsage()` 占用百分比

未用到本地/云端缓存时，卡片 `notes` 段会明确提示（如 unindexed、cacheRead=0、prefix busted、本轮未脱水等）。

`triggers` 仍会标注关键事件（重度模型 / 大量脱水 / 云端命中率跌破 50%），但默认不依赖触发条件才显示。设 `telemetryAlwaysShow: false` 可改回仅触发时写入卡片。

相关配置项：`telemetryEnabled`、`telemetryHeavyModelPattern`、`telemetryDehydrationNotifyRatio`、`telemetryCacheBustHitRateFloor`、`telemetryAlwaysShow`（默认 `true`）。

### 5. 状态栏与命令
- **状态栏展示**：`📦 Repo: Cached (HEAD: a1b2c)` 或 `📦 Repo: Uncached`，仅作状态展示，绝不自动切模型。
- **`/rescan` 命令**：手动清除工作区 `.pi/scan-cache.json` 并立即触发 scout 重扫。
- **`/cache-audit` 命令**：强制展示最近一轮遥测审计卡片。
