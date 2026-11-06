# cache-and-orchestrator — 架构缓存与双 Subagent 隔离编排扩展

采用 **“主会话固定 (保 100% KV Cache) + Subagent 物理隔离 (天然上下文折叠)”** 架构，替代脆弱的单会话频繁切模状态机。

---

## 核心架构原则

1. **主会话不换模型**：
   - 会话初始阶段按北京时间闲忙时自动初选主力模型（高峰期 `GLM-5.3-Flash`，闲时 `GLM-5.3`）；
   - 消息数 > 2 立即锁定 **Cache 黏性锁**，中途绝不自动切换模型，确保云端 Prompt Cache 100% 持续命中。
2. **重活累活物理隔离**：
   - 扫库找文件交由 `scout`（Gemini 3.8 Flash）在独立只读子环境中执行，把 2000 tokens 架构指纹存入 `.pi/scan-cache.json`；
   - 顶层方案设计交由 `architect`（Gemini 4 Argon）在无工具、极简 5K tokens 单轮独立子会话中完成，产出 `<task_spec>`；
   - 主会话主力模型根据任务蓝图直接编码、测试与修改，零全库盲扫冲动，零 Argon 昂贵配额沉余。

---

## 专用工具与模型分工

| 工具 | 角色 | 默认模型 | 权限与职责 |
|---|---|---|---|
| **`scout`** | 代码库侦察兵 | `google/gemini-3.8-flash` | 仅限只读工具（`read`, `grep`, `find`, `ls`）。全量扫描代码库，提取技术栈、顶层目录职责与核心入口，写入工作区 `.pi/scan-cache.json`，仅向主会话返回精简报告。 |
| **`architect`** | 顶层规划师 | `google/gemini-4-argon` | 零代码编辑工具。接收主会话传来的【架构摘要 + 关键切片 + 需求】，单轮独立输出包含文件路径、函数签名的 `<task_spec>...</task_spec>` 技术蓝图。 |

---

## 核心职责与机制

1. **会话级架构指纹静默挂载 (`before_agent_start`)**：
   - 检查 `.pi/scan-cache.json`，若当前未扫描或变更文件 >= 8，提示主模型优先调用一次 `scout`；
   - 若命中缓存，将浓缩指纹置顶注入，并注入编排规则（常规编码直接改，跨多模块重构/并发协议设计时调用 `architect`）。
2. **黏性 KV Cache 闲忙时初选 (`session_start`)**：
   - 仅在消息数 <= 2 时，根据北京时间 (UTC+8) 工作日 14:00-18:00 高峰期（1x）初选 `GLM-5.3-Flash`，其余时间（0.5x 半价）初选 `GLM-5.3`；
   - 累积上下文后激活 Cache 锁，会话中途跨时段绝不自动切模。
3. **手动切高费率模型防破产兜底 (`context`)**：
   - 若用户通过 `/model` 手动切到 `argon` 或 `opus` 等高成本模型，自动开启脱水保护视图（将 2 轮以前超过 500 字符的工具输出替换为摘要占位符 + 架构缓存），切回常规模型恢复原始完整视图。
4. **状态栏呈现**：
   `📦 Scan: Cached (cee1a4a) | 🔥 Cache Lock: Active | ⏱️ Z.ai: 0.5x`

---

## 自定义配置与按时段排期（基于本机时间）

支持在工作区 `.pi/orchestrator.json` 或全局 `~/.pi/agent/state/cache-and-orchestrator.json` 覆盖所有模型与按时段模型排期：

```json
{
  "scoutModel": "google/gemini-3.8-flash",
  "architectModel": "google/gemini-4-argon",
  "defaultExecuteModel": "zai/glm-5.3",
  "defaultRate": "0.5x",
  "schedules": [
    {
      "name": "workday-peak",
      "days": [1, 2, 3, 4, 5],
      "start": "14:00",
      "end": "18:00",
      "model": "zai/glm-5.3-flash",
      "rate": "1.0x"
    }
  ]
}
```

- **`scoutModel` / `architectModel`**：自定义子任务模型。
- **`schedules`**：按**本机时间 (Local Time)**生效的模型排期列表。命中时自动初选为对应时段模型；未命中走 `defaultExecuteModel`。
- **跨天支持**：支持跨天时间段（如 `"start": "23:00", "end": "06:00"`）。

---

## 快捷命令

- `/rescan`：清除 `.pi/scan-cache.json` 并调用 `scout` 强制全量更新项目架构指纹。
