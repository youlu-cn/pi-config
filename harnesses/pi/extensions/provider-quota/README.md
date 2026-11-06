# Provider Quota (`provider-quota`)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Modular multi-provider quota and rate-limit monitor for Pi coding agent.

Adopts a **Microkernel Scheduler + Pluggable Provider Adapters** architecture to query subscription quotas, rate limits, and reset countdowns across providers.

---

## Architecture

```text
provider-quota/
├── index.ts               # Extension entry: registers /quota command, lifecycle hooks, and broadcasts
├── types.ts               # Normalized data models and Adapter contracts
├── registry.ts            # Adapter registry: manages and routes all provider adapters
├── scheduler.ts           # Scheduler: TTL caching, throttling, on-demand query
├── auth-helper.ts         # Unified auth helpers (reads auth.json, env variables)
└── adapters/              # Provider adapters
    ├── base.ts            # Base utilities and normalized window builders
    ├── antigravity.ts     # Google Antigravity / Gemini adapter
    ├── gpt.ts             # OpenAI / ChatGPT / Codex adapter
    ├── claude.ts          # Anthropic Claude adapter
    └── grok.ts            # xAI Grok adapter
```

---

## Commands

- `/quota`: Displays active and configured quota details and reset countdowns.
