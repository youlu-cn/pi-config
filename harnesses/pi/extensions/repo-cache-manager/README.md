# repo-cache-manager

A Pi extension built on **Subagent Physical Isolation + Workspace Scan Cache Mounting**.

## Core Principles
- **Strictly No `setModel()`**: The extension never mutates or intercepts your active session model. The primary session retains your manually chosen model 100% of the time, preserving server-side KV Cache hit rates.
- **Physical Isolation & Ephemeral Subagents**: Workspace scanning (`scout`) and architecture planning (`architect`) run inside isolated child processes with sandboxed read-only permissions and are stopped immediately upon completion.
- **On-Demand Mounting & Cross-Model Protection**: By default the architecture summary is injected only on heavy-model turns (Argon/Opus/…); light-model turns pay no summary tax. Bulky tool outputs are still dehydrated on manual model switches.

---

## Architecture & Tools

### 1. Dedicated Subagents
- **`scout` (Codebase Reconnaissance)**
  - Model: `antigravity/gemini-3.8-flash` (configurable)
  - Permissions: Read-only tools (`read, grep, find, ls`)
  - Responsibility: Traverses project hierarchy, entry points, and interface signatures in an isolated subagent; writes a high-density summary (<2000 tokens) to `.pi/scan-cache.json` with the current `git rev-parse HEAD`, and returns the summary to the main session.
- **`architect` (Principal System Architect)**
  - Model: `antigravity/gemini-4-argon` (configurable)
  - Permissions: Read-only / pure reasoning (file modifications strictly forbidden)
  - Responsibility: For complex refactorings or protocol/concurrency designs, receives the architectural summary + relevant code slices + task requirements (<5K tokens) and produces a concrete `<task_spec>` specifying files, signatures, and steps.

### 2. Status Detection & System Prompt Injection (`before_agent_start`)
Compares workspace `.pi/scan-cache.json` with `git rev-parse HEAD` and dirty file count. Injection is gated by `injectRepoCacheOn` (default `"heavy"`):
- **Light model / `deferred`**: no `repo_cache` section (zero summary tax); on-disk cache remains for later heavy turns.
- **Heavy + `SCANNED`**: mounts `repoSummary` (plus dirty filenames if any).
- **Heavy + `UNSCANNED`**: nudges `scout` once.
- `"always"` / `"never"`: force every-turn injection or dehydration-only.

### 3. Cross-Model Context Protection (`context` hook)
- **Same Model Continuation**: Returns the original message list completely untouched (100% identity preservation) to maximize KV Cache hits.
- **Manual Model Switch**: When switching to a different model (e.g., Argon or Opus), prunes bulky historical `role === "toolResult"` file read outputs into concise placeholders, preventing re-computation costs.

### 4. Full-Chain Cache Telemetry
Collects five metric groups across `before_agent_start` → `context` → `before_provider_request` → `message_update` / `message_end` → `turn_end`, and **emits a Cache Audit card every turn by default** (`ctx.ui.notify` + non-LLM `repo-cache-audit` entry):

1. **Prefix & Injection** — `repoCacheStatus`, `sysPromptHash` (`⚠️ SYS_MUTATED` on change), `prefixLocked` (`🔒 LOCKED` / `💥 BUSTED at msg[i]`)
2. **Local Dehydration** — `rawEstTokens` vs `sentEstTokens`, `omittedTools`, saved-token ratio
3. **Cloud Usage** — `input` / `cacheRead` / `cacheWrite` / `output`, `cloudCacheHitRate = cacheRead / (input + cacheRead)`
4. **Thinking Tax** — provider `usage.reasoning` when available, else `visibleChars / 3.5` estimate
5. **Latency & Window** — `ttftMs` / `totalDurationMs`, plus `ctx.getContextUsage()` percent

When local/cloud cache was unused, the card `notes` section calls it out (unindexed, cacheRead=0, prefix busted, no dehydration, etc.).

`triggers` still tag heavy models / large dehydration / hit-rate drop below 50%, but display no longer depends on them. Set `telemetryAlwaysShow: false` for trigger-only notify.

Config keys: `telemetryEnabled`, `telemetryHeavyModelPattern`, `telemetryDehydrationNotifyRatio`, `telemetryCacheBustHitRateFloor`, `telemetryAlwaysShow` (default `true`).

### 5. Status Bar & Commands
- **Statusline Segment**: Displays `📦 Repo: Cached (HEAD: a1b2c)` or `📦 Repo: Uncached`.
- **`/rescan` Command**: Clears `.pi/scan-cache.json` and immediately runs scout.
- **`/cache-audit` Command**: Force-prints the latest telemetry audit card.
