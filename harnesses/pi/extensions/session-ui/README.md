# Pi session-ui

[English](./README.md) | [简体中文](./README.zh-CN.md)

Pi terminal UI extension providing a Claude-style startup header (gradient logo + keybinding tips), sticky fullscreen user-message header, Mermaid dialect rendering and circled-number normalization, a `/context` context-window breakdown panel, a single-line footer statusline, tool activity panel, work animation, compact clipboard image paste with preview, `/effort` switcher, turn duration, and automatic terminal title and session naming.

## Quick Start

From the repository root (requires Pi 1.4.0 and `rsync`):

```bash
./install-harness.sh pi
```

Installs to `~/.pi/agent/extensions/session-ui/`. Restart Pi or run `/reload` to apply.

## Usage

### Features & Commands

| Module | Command / Trigger | Description |
| --- | --- | --- |
| Startup header | Automatic | Official Pi gradient logo + dynamic keybinding tips + hero line (replaces the built-in startup header; narrow terminals stack logo + hero) |
| Sticky user message | Automatic (fullscreen) | Pins the scrolled-off user prompt to the viewport top; click jumps back to that message |
| Markdown enhance | Automatic | Extra Mermaid dialects (`sequenceDiagram`, `stateDiagram-v2`, …) via grok-mermaid; circled numbers `①–⑳` → `(1)–(20)`; multiline link whitespace cleanup |
| Context breakdown | `/context` | Overlay of system / memory / skills / tools / results / conversation token share; ↑↓ select, Enter preview (c / Tab+Enter copy), Esc close; non-TUI falls back to notify |
| Session / subagent references | `@` autocomplete | `@session:[…]` injects prior-session transcripts; `@subagent:[…]` suggests agent types and asks the model to delegate separately |
| Claude tool cards | `/tool-style [on\|compact\|off\|status]` | Rich Diff (bars / split), consecutive tool grouping, click/`Ctrl+O` expand; `compact` keeps one-line summaries until expanded |
| Special cards | Automatic | AskUserQuestion Q&A tree, Codemode nested-call tree, Subagent finished notification |
| Agent Summary | Automatic | End-of-agent line `│ Ran 1 command, wrote 1 file · 15s` (non-LLM entry) |
| Compact Thinking | Automatic | Collapses thinking to animated title + N preview lines; click to expand; completed shows `Thought for Xs` |
| Editor prefix | Automatic | Claude Code-style `❯` prompt |
| Aliases | `/clear` · `/exit` | `/clear` starts a new session; `/exit` shuts down |
| Tool activity | Automatic | Lists current-turn tool calls above the editor (`◆` running, `◇` done, `✗` failed; nested Codemode calls are indented) and clears when the turn ends |
| Work animation | `/work-animation on\|off\|status` | Working row includes `↓ tokens · elapsed · avg tok/s · TTFT`; toggle persists in `~/.pi/agent/state/session-ui.json` |
| Image paste & preview | `Ctrl+V` (macOS) | Inserts compact `[image #1]` placeholders; move the cursor onto a placeholder to preview (requires Kitty or iTerm2 image protocol; `Cmd+V` pastes text only) |
| Statusline | `/statusline` | Temporarily switches between the custom single-line statusline and the native footer |
| Thinking effort | `/effort [level\|status]` | Opens the level selector without arguments, or sets the level directly |
| Turn summary | Automatic | Shows elapsed duration, model, and thinking effort at the end of each assistant turn (`󰔛 4.2s · antigravity/gemini-3.8-flash (medium)`) |
| Title & naming | Automatic / `/name` | Piggybacks on normal main-model responses (no extra model calls): names unnamed sessions once a clear goal emerges (never overwrites existing names) and updates the terminal title as activity changes; skipped during detached background runs |

### Statusline Segments

Displayed items and order are controlled by `statusline.segments`:

| ID | Content |
| --- | --- |
| `model` | Active model (abbreviated to model ID on narrow terminals) |
| `effort` | Thinking effort (hidden when `off`) and `fast` badge |
| `directory` | Current working directory |
| `branch` | Git branch |
| `context` | Context window usage percentage and capacity |
| `usage` | Subscription window quota and reset countdown (requires `pi-subscription-usage`) |
| `cache` | Assistant request cache hit rate (`last/recent5/session`) |
| `extensions` | Other non-excluded extension statuses |
| `tokens` | Cumulative input / output tokens (`↑in ↓out`, hidden by default in repo config) |
| `session` | Session name (hidden by default) |

`fast` only indicates that local fast-mode handling is active; see [Fast](../fast/README.md). Check MCP status with `/mcp`.

### Configuration

- Default path: `~/.pi/agent/extensions/session-ui/config.json` (repo source: [config.json](../../plugin-configs/session-ui/config.json))
- Environment override: `PI_SESSION_UI_CONFIG=/absolute/path/to/session-ui.json pi`

Run `/reload` after editing. All modules (`toolActivity`, `workAnimation`, `agentSummary`, `compactThinking`, `editorPrefix`, `aliases`, `specialCards`, `compactPaste`, `claudeToolStyle`, `statusline`, `effort`, `turnSummary`, `uiMeta`, `startupHeader`, `markdownEnhance`, `contextCommand`, `reference`, `stickyUserMessage`) are enabled by default and can be disabled with `enabled: false`:

| Option | Default | Allowed Values / Range |
| --- | --- | --- |
| `startupHeader.enabled` | `true` | Gradient logo + tips startup header |
| `stickyUserMessage.enabled` | `true` | Pin scrolled-off user message at fullscreen viewport top |
| `markdownEnhance.enabled` | `true` | Mermaid dialects + circled-number normalization |
| `contextCommand.enabled` | `true` | `/context` context-window breakdown panel |
| `reference.enabled` | `true` | Master switch for `@session` / `@subagent` references |
| `reference.sessionReference` | `true` | `@session:[…]` autocomplete + transcript injection |
| `reference.subagentAutocomplete` | `true` | `@subagent:[…]` agent-type autocomplete + delegation hint |
| `editorPrefix.enabled` | `true` | `❯` prompt prefix |
| `aliases.enabled` | `true` | `/clear` and `/exit` aliases |
| `specialCards.enabled` | `true` | AskUser / Codemode / Subagent cards |
| `claudeToolStyle.mode` | `"on"` | `"on"` \| `"compact"` \| `"off"` |
| `claudeToolStyle.grouping` | `true` | Collapse consecutive tool cards into a group header |
| `claudeToolStyle.diffViewMode` | `"auto"` | `"auto"` \| `"unified"` \| `"split"` |
| `claudeToolStyle.diffIndicatorMode` | `"bars"` | `"bars"` \| `"classic"` \| `"none"` |
| `claudeToolStyle.diffSplitMinWidth` | `120` | Min terminal width for split diffs |
| `claudeToolStyle.editDiffCollapsedLines` | `12` | Collapsed edit diff lines; `0` = summary only |
| `claudeToolStyle.writeDiffCollapsedLines` | `8` | Collapsed write preview lines; `0` = summary only |
| `agentSummary.enabled` | `true` | End-of-agent tool summary line |
| `agentSummary.minToolCount` | `1` | Emit summary after at least N tools |
| `compactThinking.enabled` | `true` | Compact thinking blocks |
| `compactThinking.previewLines` | `3` | Live preview lines |
| `compactThinking.completedPreviewLines` | `1` | Completed preview lines; `null` follows previewLines |
| `compactThinking.animationIntervalMs` | `90` | Title animation interval |
| `toolActivity.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `toolActivity.maxItems` | `6` | `1`–`20` |
| `workAnimation.placement` | `"aboveEditor"` | `"aboveEditor"` \| `"belowEditor"` |
| `workAnimation.showStats` | `true` | Show tokens / elapsed / tok/s on the working row |
| `workAnimation.showTtft` | `true` | Include TTFT next to rate |
| `workAnimation.tokenRateMode` | `"average"` | `"average"` \| `"live"` |
| `workAnimation.intervalMs` | `180` | `100`–`500` (ms) |
| `statusline.overflow` | `"drop-right"` | `"drop-right"` (hide from right) \| `"priority"` (compact first, then hide by priority) |
| `statusline.segments` | Default list above | Array of segment IDs (replaces the full list and deduplicates) |
| `statusline.extensionStatuses.exclude` | `[]` | Array of status IDs to exclude (supports `*` wildcards) |
| `turnSummary.showDuration` | `true` | `boolean` (show elapsed duration) |
| `turnSummary.showModel` | `true` | `boolean` (show model used) |
| `turnSummary.showEffort` | `true` | `boolean` (show thinking effort) |
| `uiMeta.title.enabled` | `true` | `boolean` |
| `uiMeta.title.maxLength` | `36` | `8`–`80` |
| `uiMeta.sessionName.enabled` | `true` | `boolean` |
| `uiMeta.sessionName.maxLength` | `48` | `8`–`100` |
