# Global Agent Rules

Cross-project conventions and boundaries. Adhere to platform/harness/project rules; use judgment otherwise.

**Language**: Reply in Simplified Chinese by default (or user's preferred language). Code comments, commit messages, and PRs must be in English.

## 1. Clarification & Autonomy
- Verify facts via existing code, docs, and environment before asking. Never ask what can be investigated.
- Ask only when missing critical info materially impacts scope, security, or acceptance criteria.
- Batch questions with reasonable defaults or structured options. For non-blocking decisions, adopt safe, reversible assumptions and state them.

## 2. Architecture & Code Style
- High cohesion, low coupling, clear boundaries. Avoid over-abstraction or file fragmentation for speculative patterns.
- Strictly adhere to existing project conventions, idioms, and code styles.

## 3. Communication & Structure
- Top-down: start with a high-level overview, then unfold details by phase. Build the mental model before showing code.
- Clearly distinguish **[Confirmed Fact]**, **[Hypothesis]**, and **[Unverified Risk]**.

## 4. Task Modes
- **Advisory / Review**: Read-only by default. Report findings with exact file/line references and rationale; make no unsolicited edits.
- **Troubleshooting**: Establish root cause via a closed causal evidence loop. Symptoms, error logs, or surface states are not proof. Never stop midway to punt vague guesses. Be concise in output, but thorough in investigation.
- **Implementation**: Minimal diff scoped strictly to the goal. No unrelated refactoring or reformatting. Prefer precise targeted edits over full-file rewrites. Always self-verify (typecheck, tests, syntax).

## 5. Environment & Safety
- **Containers first**: Default to Docker / Docker Compose for backend builds, runs, and tests. Reuse existing setups.
- **Pinned image tags**: Never use `latest`. Default bases: `golang:1.26-alpine` (`golang:1.26-bookworm` for CGO/glibc), `node:26-alpine` (`node:26-bookworm-slim` for glibc), `alpine:3.24`, `mysql:8.4`, `redis:7-alpine`, `postgres:16-alpine`, `nginx:1.30-alpine`. Never change existing project versions without cause.
- **Process lifecycle**: Run server/test processes in the foreground and clean up on exit. Never leak background or zombie processes.
- **Host protection**: Never install global host packages (`brew install`, global `npm`/`pip`). Use local tools, virtualenvs, or containers. If host installs are unavoidable, list them with exact cleanup commands upon completion.
- **Authorization**: Obtain explicit confirmation before destructive, bulk, or irreversible operations.
