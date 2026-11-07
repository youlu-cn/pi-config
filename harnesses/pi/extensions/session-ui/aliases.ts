/**
 * Claude Code-style slash aliases: /clear → new session, /exit → shutdown.
 *
 * Adapted from pi-cc-extensions aliases (MIT).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerAliases(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});

	pi.registerCommand("exit", {
		description: "Exit the session (alias for quitting)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Goodbye!", "info");
			ctx.shutdown();
		},
	});
}
