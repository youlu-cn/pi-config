# Fast

[English](./README.md) | [简体中文](./README.zh-CN.md)

Use `/fast [on|off|status]` with OpenAI or Codex Responses models authenticated via ChatGPT OAuth. With no argument, the command toggles the current provider's preference. Fast is off by default.

Run `./install-harness.sh` from the repository root, then run `/reload` and `/fast on` in Pi.

When enabled, the extension sets `service_tier` to `"priority"` only when the request does not already specify a tier. API-key authentication and other providers are unsupported. The model and endpoint are unchanged. The badge describes local policy, not server acceptance, latency, or billing.

Set `enabled` (default `false`) and `showStatus` (default `true`) in `fast.json` in the Pi agent directory. Provider preferences override the default and persist in `state/fast.json`.
