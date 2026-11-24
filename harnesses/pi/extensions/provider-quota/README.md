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

- Claude Code Bridge quota is unavailable until a real usage source is integrated; no synthetic 100% windows or reset timestamps are emitted.
- Only the latest refresh can update the statusline. Late responses after provider/model switches or scheduler shutdown cannot replace current usage.
- Adapters default to `modelKeys` matching, even for a single returned group. Provider-wide adapters explicitly declare `modelMatching: "all"`.

- Antigravity reports two quota pools: Gemini Models (shared by Carbon, Hydrogen, Neon, and legacy Argon) and Claude and GPT models. Obsolete standalone Argon summary groups are ignored to avoid duplicate weekly windows.

- Statusline windows are attributed per model group. When switching to an unknown provider (e.g. `cursor`, `deepseek`) or an unmatched model group, the `usage` segment is cleared instead of showing stale quota from the previous model.
- Antigravity queries `https://daily-cloudcode-pa.googleapis.com` first with the full CLI `User-Agent` and reads live `remainingFraction` values rather than fabricating 100% remaining.
