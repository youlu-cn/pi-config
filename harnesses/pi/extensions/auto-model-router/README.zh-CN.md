# auto-model-router — Pi 确定性免路由模型智能分流插件

类似 Cursor 中的 "Auto Model" 机制，通过**确定性有限状态机**与**启发式上下文分析**（无需调用外部路由模型），在 `Gemini 3.8 Flash`、`Gemini 4 Argon` 和 `Z.ai (GLM-5.3 / GLM-5.3-Flash)` 之间无感自动切换，并借助**动态上下文折叠**保护高价值模型的配额。

---

## 核心架构与模型角色

| 角色 | 默认模型 | 职责与触发场景 |
|---|---|---|
| **SCOUT (全量侦察)** | `google/gemini-3.8-flash` | 本地未建立指纹或变更严重（>=8 文件）时强制触发，使用 `find`/`grep`/`read` 极速浓缩全库架构摘要 `<repo_summary>`（限制 2000 tokens 内） |
| **PLAN (架构规划)** | `google/gemini-4-argon` | 侦察完成后的首次复杂方案、命中核心架构/重构正则、跨 >=4 模块高影响面变更、或显式执行 `/plan`。**单轮规划后立即切出，绝不进入多轮编码循环** |
| **EXECUTE_FULL (主力执行)** | `zai/glm-5.3` | 非高峰时段（享受 0.5x 半价计费时段，含北京时间工作日 18:00 后、早间及周末全天），多轮读写代码、跑测试、修 Bug |
| **EXECUTE_FLASH (高峰/轻量)** | `zai/glm-5.3-flash` | 工作日高峰期（北京时间 UTC+8 周一至周五 14:00 - 18:00，享受 3 倍配额）或单文件简单微调 |

---

## 核心防破产机制：上下文折叠与工具剥离

当切换至 `Argon` 规划模型时，`context` 钩子动态拦截重组发送给模型的 `messages`：
1. **剥离沉余**：过滤历史中所有 `role === "toolResult"` / `role === "tool"` 的大体积文件读取与命令输出。
2. **知识注入**：注入 `.pi/scan-cache.json` 中的架构指纹（及增量未提交修改的 `git diff` 摘要）。
3. **保留焦点**：仅保留最近 2 轮用户的核心意图。
4. **强约束指令**：强制要求 Argon 直接输出 `<task_spec>...</task_spec>`，严禁调用写文件工具，在 1 轮内完成规划。
5. **即刻切出**：`turn_end` 收到 Task Spec 后，立即强制将阶段切回 `EXECUTE`，让 Z.ai 照着 Task Spec 落地代码。

---

## 快捷命令

- `/auto`：开启 / 关闭 Auto 自动路由模式（关闭时自动恢复用户手动选择的模型）。
- `/rescan`：强制清除 `.pi/scan-cache.json` 并在下一轮对话启动全库侦察。
- `/plan [需求]`：强制在下一轮使用 Argon 进行顶层架构规划（带上下文折叠与 Task Spec 约束）。

---

## 状态栏格式

底部状态栏实时显示：
`🤖 Auto: [PLAN | Argon] | 📦 Repo: Clean (HEAD: a1b2c) | ⏱️ Z.ai: Off-Peak (0.5x)`
