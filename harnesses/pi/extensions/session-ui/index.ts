/**
 * session-ui — composable Pi session presentation.
 *
 * Design constraints:
 * - Never replace tool execution. Tool lifecycle events feed ephemeral UI projections.
 * - Paste placeholders reuse Pi's native editor registry behind runtime guards.
 * - Footer modules are registered segments whose order is controlled by config.
 * - UI metadata, work state, and animation frames share one terminal-title owner.
 *
 * Installed configuration: ./config.json
 * Override path: PI_SESSION_UI_CONFIG=/absolute/path/to/config.json
 *
 * Commands:
 *   /effort [level|status]
 *   /statusline
 *   /work-animation [on|off|status]
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactPasteEditor } from "./compact-paste.ts";
import { registerClaudeToolRenderer } from "./claude-tool-renderer.ts";
import { loadSessionUiConfig } from "./config.ts";
import { registerEffort } from "./effort.ts";
import { registerStatusline } from "./statusline.ts";
import { registerSessionTitleController } from "./title-controller.ts";
import { registerToolActivity } from "./tool-activity.ts";
import { registerTurnSummary } from "./turn-summary.ts";
import { registerUiMeta } from "./ui-meta.ts";
import { registerWorkAnimation } from "./work-animation.ts";

export default function sessionUi(pi: ExtensionAPI): void {
	const loaded = loadSessionUiConfig();
	const { config } = loaded;
	const titleController = registerSessionTitleController(pi);

	if (config.turnSummary.enabled) registerTurnSummary(pi, config.turnSummary);
	if (
		config.uiMeta.enabled &&
		(config.uiMeta.title.enabled || config.uiMeta.sessionName.enabled)
	) {
		registerUiMeta(pi, config.uiMeta, titleController);
	}
	const workAnimController = registerWorkAnimation(
		pi,
		config.workAnimation,
		join(getAgentDir(), "state", "session-ui.json"),
		titleController,
	);
	if (config.compactPaste.enabled) registerCompactPasteEditor(pi);
	if (config.claudeToolStyle?.enabled ?? true) {
		registerClaudeToolRenderer(pi, {
			getStyle: () => config.claudeToolStyle.style ?? workAnimController.getStyle(),
			getIntervalMs: () =>
				config.claudeToolStyle.intervalMs ?? workAnimController.getIntervalMs(),
		});
	}
	if (config.toolActivity.enabled) {
		registerToolActivity(pi, config.toolActivity);
	}
	if (config.statusline.enabled) registerStatusline(pi, config.statusline);
	if (config.effort.enabled) registerEffort(pi);

	if (loaded.warnings.length > 0) {
		let notified = false;
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI || notified) return;
			notified = true;
			ctx.ui.notify(
				`session-ui config (${loaded.path}): ${loaded.warnings.join("; ")}; using defaults for invalid or missing values`,
				"warning",
			);
		});
	}
}
