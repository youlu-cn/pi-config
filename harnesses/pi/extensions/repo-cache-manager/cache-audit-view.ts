import { Box, Container, MouseRegion, Text } from "@earendil-works/pi-tui";
import { formatAuditCardText, type CacheAuditCard } from "./telemetry.ts";

/** Minimal theme surface used by the audit card renderer. */
export interface AuditTheme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
}

/**
 * Per-card expand state. CustomEntryComponent rebuilds its child on every
 * invalidate / ctrl+o, so click-expand must live outside the component instance.
 */
const expandStateByTs = new Map<number, { hostExpanded: boolean; localExpanded: boolean }>();

function resolveExpanded(timestamp: number, hostExpanded: boolean): boolean {
	let state = expandStateByTs.get(timestamp);
	if (!state) {
		state = { hostExpanded, localExpanded: hostExpanded };
		expandStateByTs.set(timestamp, state);
		return state.localExpanded;
	}
	if (state.hostExpanded !== hostExpanded) {
		// Global ctrl+o (or host rebuild) changed — sync local to host.
		state.hostExpanded = hostExpanded;
		state.localExpanded = hostExpanded;
	}
	return state.localExpanded;
}

function toggleLocalExpanded(timestamp: number): boolean {
	const state = expandStateByTs.get(timestamp);
	if (!state) {
		expandStateByTs.set(timestamp, { hostExpanded: false, localExpanded: true });
		return true;
	}
	state.localExpanded = !state.localExpanded;
	return state.localExpanded;
}

/**
 * Self-expanding Cache Audit card.
 *
 * Pi's CustomEntryComponent does not wrap entries in MouseRegion, so left-click
 * must be owned here. Expand state is keyed by card.timestamp so it survives
 * host rebuilds while still tracking ctrl+o via the host `expanded` flag.
 */
export class CacheAuditCardView extends Box {
	private card: CacheAuditCard;
	private theme: AuditTheme;
	private expanded: boolean;
	private expandHint: string;

	constructor(card: CacheAuditCard, theme: AuditTheme, hostExpanded = false, expandHint = "ctrl+o") {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.card = card;
		this.theme = theme;
		this.expandHint = expandHint;
		this.expanded = resolveExpanded(card.timestamp, hostExpanded);
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		const state = expandStateByTs.get(this.card.timestamp);
		if (state) {
			state.localExpanded = expanded;
			state.hostExpanded = expanded;
		} else {
			expandStateByTs.set(this.card.timestamp, {
				hostExpanded: expanded,
				localExpanded: expanded,
			});
		}
		this.rebuild();
	}

	invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();

		const hit =
			this.card.cloudCacheHitRate != null
				? `${(this.card.cloudCacheHitRate * 100).toFixed(0)}%`
				: "n/a";
		const inject =
			this.card.injection.repoCacheStatus === "injected"
				? "injected"
				: this.card.injection.repoCacheStatus === "deferred"
					? "deferred"
					: this.card.injection.repoCacheStatus;
		const triggerNote =
			this.card.triggers.length > 0
				? this.theme.fg("warning", ` [${this.card.triggers.join(", ")}]`)
				: "";

		const content = new Container();
		const hint = this.expanded
			? `  (click / ${this.expandHint} to collapse)`
			: `  (click / ${this.expandHint} to expand)`;
		const header = `${this.theme.fg("accent", "📡 Cache Audit")}${triggerNote}  ${this.theme.fg(
			"dim",
			`${this.card.prefix.label} · ${inject} · hit=${hit}${hint}`,
		)}`;
		content.addChild(new Text(header, 0, 0));

		if (this.expanded) {
			// Skip the banner line from formatAuditCardText — header already shows the title.
			const lines = formatAuditCardText(this.card).split("\n");
			for (const line of lines) {
				if (line.startsWith("═══")) continue;
				content.addChild(new Text(this.theme.fg("dim", line), 0, 0));
			}
		} else {
			const compact = `   ${this.card.dehydration.rawEstTokens}→${this.card.dehydration.sentEstTokens} tok · ttft=${this.card.timing.ttftMs ?? "n/a"}ms`;
			content.addChild(new Text(this.theme.fg("dim", compact), 0, 0));
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.expanded = toggleLocalExpanded(this.card.timestamp);
				this.rebuild();
				return { handled: true };
			}),
		);
	}
}
