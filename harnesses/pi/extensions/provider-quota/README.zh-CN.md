# Provider Quota (`provider-quota`)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi 多模型 / 多订阅配额与速率限制监控扩展。

采用**微内核调度器（Microkernel Scheduler）+ 插件化厂商适配器（Registry Adapters）**架构，统一采集各 AI Provider 的使用额度、速率配额与周期重置倒计时。

---

## 核心设计

```text
provider-quota/
├── index.ts               # 扩展入口：注册 /quota 命令、生命周期监听与状态栏事件广播
├── types.ts               # 归一化数据模型与 Adapter 接口契约
├── registry.ts            # Adapter 注册表：管理所有 Provider 适配器及其路由
├── scheduler.ts           # 调度引擎：TTL 缓存、防频防刷、按需轮询
├── auth-helper.ts         # 统一鉴权提取助手 (从 auth.json、环境变量读取凭据)
└── adapters/              # 厂商适配器
    ├── base.ts            # 基础工具与归一化 Window 构建函数
    ├── antigravity.ts     # Google Antigravity / Gemini 适配器
    ├── gpt.ts             # OpenAI / ChatGPT / Codex 适配器
    ├── claude.ts          # Anthropic Claude 适配器
    └── grok.ts            # xAI Grok 适配器
```

---

## 特性与优势

1. **统一归一化数据**：无论底层是 OAuth、API Key、Web 逆向还是特定协议，所有适配器统一输出 `remainingPercent`（0~100）和 `resetsAt`（时间戳）。
2. **与 `session-ui` 无缝协作**：查询成功后派发标准 `subscription-usage/status/v1` 事件，`session-ui` 状态栏的 `usage` 段直接呈现额度百分比与倒计时。
3. **开闭原则（OCP）**：新增任何模型厂商支持（如 Kimi、DeepSeek、Minimax），只需在 `adapters/` 下增加一个适配器并在 `registry.ts` 中注册，核心调度与交互代码零改动。
4. **节流与保护**：自带 60s TTL 缓存机制，超时（5秒）自动取消，静默保底不阻断交互。

---

## 交互命令

- `/quota`：手动查看当前模型及所有已配置 Provider 的配额详情、账号与重置倒计时。

---

## 行为说明

- Claude Code Bridge 在接入真实用量来源前返回不可用，不生成虚构的 100% 剩余额度或重置时间。
- 仅最新刷新可更新状态栏；切换 Provider/模型或停止调度器后的迟到响应不会覆盖当前用量。
- 适配器默认按 `modelKeys` 匹配，即使只返回一个分组；全 Provider 共用额度的适配器须显式声明 `modelMatching: "all"`。

- Antigravity 只显示两个配额池：Gemini Models（Carbon、Hydrogen、Neon 及旧版 Argon 共用）和 Claude and GPT models。忽略接口单独返回的旧 Argon 分组，避免重复显示 Gemini 的周额度。

- 状态栏额度按“模型分组”归属：切换到未注册的 Provider（如 `cursor`、`deepseek`）或未匹配的分组时，`usage` 段会被清空，不会残留上一个模型的额度。
- Antigravity 优先请求 `https://daily-cloudcode-pa.googleapis.com` 并携带完整 CLI `User-Agent`。剩余百分比取自接口的 `remainingFraction`，不生成硬编码的 100% 兜底窗口。
