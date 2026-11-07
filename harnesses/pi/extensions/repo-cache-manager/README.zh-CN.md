# repo-cache-manager

基于 **Subagent 物理隔离 + 项目扫描缓存挂载** 的 Pi 插件。

## 核心原则
- **绝对不调用 `setModel()`**：插件绝不自动切换或篡改当前主会话模型。主会话永远保持用户选择的模型，天然保障主模型 100% 的 KV Cache 命中率。
- **物理隔离，跑完即焚**：全量代码扫描（`scout`）与架构规划（`architect`）分别在独立的子进程会话中运行，使用只读权限，单轮结束立即清理。
- **静态挂载，智能保护**：通过系统提示词 sections 挂载全局架构摘要；仅在用户**手动**切换模型时，对历史巨型 tool 输出进行按需脱水保护。

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
对比当前 `git rev-parse HEAD` 与 `git status --porcelain` 变更文件数：
- **`SCANNED`** (存在缓存且变更文件 < 8 个)：直接读取 `.pi/scan-cache.json` 中的 `repoSummary`（若有少量未提交变更附带变更文件名），静默注入系统提示词中。
- **`UNSCANNED`** (无缓存或变更文件 >= 8 个)：系统提示词提醒主模型调用一次 `scout` 完成扫描。

### 3. 跨模型上下文保护 (`context` 钩子)
- **同模型持续对话**：100% 保持原始消息列表一字不改，确保云端 KV Cache 持续命中。
- **手动切换模型**：当检测到跨模型切换时，仅将切换模型前累积的巨型 `role === "toolResult"` 原始文件读取输出替换为简短占位符（头部已有 2K 架构摘要），防止新模型（如 Argon / Opus）触发数万 Token 的全价重算。

### 4. 状态栏与命令
- **状态栏展示**：`📦 Repo: Cached (HEAD: a1b2c)` 或 `📦 Repo: Uncached`，仅作状态展示，绝不自动切模型。
- **`/rescan` 命令**：手动清除工作区 `.pi/scan-cache.json` 并在下一轮对话提示重新扫描。
