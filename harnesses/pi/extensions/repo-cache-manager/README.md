# repo-cache-manager

A Pi extension built on **Subagent Physical Isolation + Workspace Scan Cache Mounting**.

## Core Principles
- **Strictly No `setModel()`**: The extension never mutates or intercepts your active session model. The primary session retains your manually chosen model 100% of the time, preserving server-side KV Cache hit rates.
- **Physical Isolation & Ephemeral Subagents**: Workspace scanning (`scout`) and architecture planning (`architect`) run inside isolated child processes with sandboxed read-only permissions and are stopped immediately upon completion.
- **Static Mounting & Cross-Model Context Protection**: System prompt sections mount the architectural summary. Bulky historical file read outputs are pruned only when you manually switch to a new model.

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
Compares workspace `.pi/scan-cache.json` with `git rev-parse HEAD` and `git status --porcelain` dirty file count:
- **`SCANNED`** (cache exists, HEAD matches, dirty files < 8): Mounts `repoSummary` silently into system prompt sections (`repo_cache`).
- **`UNSCANNED`** (no cache or dirty files >= 8): Informs the main model that the workspace is unindexed and advises invoking `scout` once.

### 3. Cross-Model Context Protection (`context` hook)
- **Same Model Continuation**: Returns the original message list completely untouched (100% identity preservation) to maximize KV Cache hits.
- **Manual Model Switch**: When switching to a different model (e.g., Argon or Opus), prunes bulky historical `role === "toolResult"` file read outputs into concise placeholders, preventing re-computation costs.

### 4. Status Bar & Commands
- **Statusline Segment**: Displays `📦 Repo: Cached (HEAD: a1b2c)` or `📦 Repo: Uncached`.
- **`/rescan` Command**: Manually clears `.pi/scan-cache.json` and prompts `scout` to rescan on the next turn.
