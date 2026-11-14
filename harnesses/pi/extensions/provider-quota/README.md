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

---

## Behavior notes

- On Google AI Pro, Argon has its own 7-day pool; Hydrogen (`gemini-4-hydrogen`, replacing 3.8 Flash) uses the original Gemini pool. Ultra tiers, identified by the returned tier ID/name, route Argon and Hydrogen to one shared pool. Reset timestamps and percentages remain API-derived; unknown tiers are not assumed to share pools.

- Statusline windows are attributed per model group. When switching to an unknown provider (e.g. `cursor`, `deepseek`) or an unmatched model group, the `usage` segment is cleared instead of showing stale quota from the previous model.
- Antigravity queries `https://daily-cloudcode-pa.googleapis.com` first with the full CLI `User-Agent` fingerprint so all three quota groups (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) and live `remainingFraction` values are returned accurately.
