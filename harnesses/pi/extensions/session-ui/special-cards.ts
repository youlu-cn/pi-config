/**
 * Register dedicated renderers for AskUserQuestion / Codemode / Subagent cards.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	formatSubagentNotification,
	SUBAGENT_NOTIFICATION_TYPE,
} from "./special-cards-core.ts";

export function registerSpecialCards(pi: ExtensionAPI): void {
	if (typeof pi.registerMessageRenderer !== "function") return;

	pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, (message, options, theme) => {
		const pad = " ".repeat(Math.max(0, options.outputPad ?? 1));
		const hint = options.expanded
			? "click / ctrl+o to collapse"
			: "click / ctrl+o to expand";
		const text = formatSubagentNotification(
			(message as { details?: unknown }).details,
			theme,
			options.expanded,
			pad,
			hint,
		);
		if (!text.trim()) return undefined;
		return new Text(text, 0, 0);
	});
}
