/**
 * Lightweight consecutive-tool grouping for session-ui.
 *
 * Patches Container.addChild/removeChild/clear so adjacent ToolExecutionComponent
 * instances collapse into a ToolGroupComponent (Claude Code style).
 *
 * Adapted from pi-cc-extensions tool grouping (MIT) — simplified for session-ui.
 */

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	MouseRegion,
	Text,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";

const PARENT_KEY = Symbol.for("session-ui.toolGroup.parent");
const GENERATION_KEY = Symbol.for("session-ui.toolGroup.generation");
const PATCH_KEY = Symbol.for("session-ui.toolGrouping.patch");

type ThemeLike = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

type ToolStatus = "pending" | "success" | "error";

type Patch = {
	active: boolean;
	prototype: any;
	original: {
		addChild: (...args: any[]) => any;
		removeChild: (...args: any[]) => any;
		clear: (...args: any[]) => any;
	};
	installed: {
		addChild: (...args: any[]) => any;
		removeChild: (...args: any[]) => any;
		clear: (...args: any[]) => any;
	};
	groups: Set<ToolGroupComponent>;
	enabled: () => boolean;
	generation: number;
	theme?: ThemeLike;
};

function toolNameOf(tool: any): string {
	return typeof tool?.toolName === "string" ? tool.toolName : "tool";
}

function capitalize(name: string): string {
	if (!name) return "Tool";
	if (name.startsWith("mcp__")) {
		const parts = name.slice(5).split("__");
		return `Mcp(${parts.join(".")})`;
	}
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function statusOf(tool: any): ToolStatus {
	if (!tool?.result) return "pending";
	if (tool.result.isError) return "error";
	return "success";
}

function statusIcon(status: ToolStatus, theme: ThemeLike): string {
	if (status === "pending") return theme.fg("accent", "●");
	if (status === "error") return theme.fg("error", "●");
	return theme.fg("success", "●");
}

function isGroupable(value: unknown): boolean {
	return value instanceof ToolExecutionComponent;
}

function previousSibling(
	children: readonly unknown[],
	from: number,
): { child: any; index: number } | undefined {
	for (let i = from; i >= 0; i--) {
		const child = children[i];
		if (child == null) continue;
		if (typeof child === "object" && (child as any).constructor?.name === "Spacer") continue;
		return { child, index: i };
	}
	return undefined;
}

export class ToolGroupComponent extends Container {
	readonly toolCallId: string;
	readonly toolName = "Tool group";
	private _expanded = false;
	private readonly patch: Patch;
	private tools: any[] = [];
	private view = new Container();
	private static nextId = 1;

	constructor(patch: Patch) {
		super();
		this.patch = patch;
		this.toolCallId = `session-ui-tool-group-${ToolGroupComponent.nextId++}`;
		patch.groups.add(this);
		super.addChild(
			new MouseRegion(this.view, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (!this._expanded || event.y === 0) {
					this.setExpanded(!this._expanded);
					return { handled: true, render: true };
				}
				return undefined;
			}),
		);
	}

	get expanded(): boolean {
		return this._expanded;
	}

	get toolCount(): number {
		return this.tools.length;
	}

	isSamePatch(other: Patch): boolean {
		return this.patch === other;
	}

	addTool(tool: any): void {
		this.tools.push(tool);
		tool[PARENT_KEY] = this;
		this.rebuild();
	}

	removeTool(tool: any): void {
		const index = this.tools.indexOf(tool);
		if (index >= 0) this.tools.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
		this.rebuild();
	}

	releaseTools(): any[] {
		const released = [...this.tools];
		this.tools.length = 0;
		this.patch.groups.delete(this);
		this.rebuild();
		return released;
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.tools) {
			(tool as { setExpanded?: (v: boolean) => void }).setExpanded?.(expanded);
		}
		this.rebuild();
	}

	invalidate(): void {
		this.rebuild();
		for (const child of this.tools) (child as Component).invalidate?.();
	}

	private rebuild(): void {
		this.view.clear();
		const theme = this.patch.theme ?? {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
		};
		const tools = this.tools;
		const counts = { pending: 0, success: 0, error: 0 };
		const labels = new Map<string, number>();
		for (const tool of tools) {
			counts[statusOf(tool)]++;
			const label = capitalize(toolNameOf(tool));
			labels.set(label, (labels.get(label) ?? 0) + 1);
		}
		const countParts: string[] = [];
		if (counts.success) countParts.push(theme.fg("success", `${counts.success} done`));
		if (counts.error) countParts.push(theme.fg("error", `${counts.error} failed`));
		if (counts.pending) countParts.push(theme.fg("accent", `${counts.pending} running`));
		const countText = countParts.join(theme.fg("dim", " · "));
		const nameList = [...labels].map(([n, c]) => `${n}×${c}`).join(", ");
		const title =
			labels.size === 1
				? [...labels.keys()][0]!
				: (theme.bold?.("Multiple Tools") ?? "Multiple Tools");
		const overall: ToolStatus = counts.error
			? "error"
			: counts.pending
				? "pending"
				: "success";
		const hint = this._expanded ? "click to collapse" : "click to expand";
		const headerText = ` ${statusIcon(overall, theme)} ${title}: ${countText}${
			nameList ? theme.fg("dim", ` · ${nameList}`) : ""
		}${theme.fg("dim", ` · ${hint}`)}`;
		this.view.addChild(new Text(headerText, 0, 0));

		if (!this._expanded) return;

		for (let i = 0; i < tools.length; i++) {
			const tool = tools[i];
			const branch = i === tools.length - 1 ? "└" : "├";
			const st = statusOf(tool);
			const label = capitalize(toolNameOf(tool));
			this.view.addChild(
				new Text(` ${theme.fg("dim", branch)} ${statusIcon(st, theme)} ${label}`, 0, 0),
			);
			try {
				const childLines = (tool as Component).render?.(80) ?? [];
				for (const row of childLines) {
					this.view.addChild(new Text(`   ${row}`, 0, 0));
				}
			} catch {
				/* ignore */
			}
		}
	}

	render(width: number): string[] {
		// Ensure header reflects latest tool statuses before paint.
		this.rebuild();
		const lines = super.render(width);
		if (lines.length === 1 && visibleWidth(lines[0]!) > width) {
			return [`${lines[0]!.slice(0, Math.max(0, width - 1))}…`];
		}
		return lines;
	}
}

function maybeGroup(patch: Patch, parent: any, component: any): void {
	if (!patch.active || !patch.enabled() || parent instanceof ToolGroupComponent) return;
	if (!isGroupable(component)) return;
	component[GENERATION_KEY] = patch.generation;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;

	const prior = previousSibling(children, index - 1);
	if (prior?.child instanceof ToolGroupComponent && prior.child.isSamePatch(patch)) {
		children.splice(index, 1);
		prior.child.addTool(component);
		return;
	}

	const members = [component];
	let firstIndex = index;
	if (prior && isGroupable(prior.child) && prior.child[GENERATION_KEY] === patch.generation) {
		members.unshift(prior.child);
		firstIndex = prior.index;
	}
	if (members.length < 2) return;

	const group = new ToolGroupComponent(patch);
	for (const member of members) group.addTool(member);
	(group as any)[PARENT_KEY] = parent;
	if (firstIndex !== index) children.splice(index, 1);
	children[firstIndex] = group;
}

function normalizeGroup(patch: Patch, group: ToolGroupComponent): void {
	if (group.toolCount > 1) return;
	const parent = (group as any)[PARENT_KEY];
	const index = parent?.children?.indexOf(group) ?? -1;
	const tools = group.releaseTools();
	delete (group as any)[PARENT_KEY];
	if (index < 0) {
		for (const tool of tools) delete tool[PARENT_KEY];
		return;
	}
	for (const tool of tools) tool[PARENT_KEY] = parent;
	parent.children.splice(index, 1, ...tools);
}

function ungroup(patch: Patch): void {
	for (const group of [...patch.groups]) {
		const parent = (group as any)[PARENT_KEY];
		const children = parent?.children;
		if (!Array.isArray(children)) {
			patch.groups.delete(group);
			continue;
		}
		const index = children.indexOf(group);
		if (index < 0) {
			patch.groups.delete(group);
			continue;
		}
		const tools = group.releaseTools();
		for (const tool of tools) tool[PARENT_KEY] = parent;
		children.splice(index, 1, ...tools);
	}
}

export type ToolGroupingHooks = {
	setTheme(theme: ThemeLike): void;
	shutdown(): void;
};

export function installToolGrouping(getEnabled: () => boolean): ToolGroupingHooks {
	const prototype = Container.prototype as any;
	const previous = (globalThis as any)[PATCH_KEY] as Patch | undefined;
	if (previous?.active) {
		previous.active = false;
		previous.enabled = () => false;
		ungroup(previous);
		if (prototype.addChild === previous.installed.addChild) {
			prototype.addChild = previous.original.addChild;
		}
		if (prototype.removeChild === previous.installed.removeChild) {
			prototype.removeChild = previous.original.removeChild;
		}
		if (prototype.clear === previous.installed.clear) {
			prototype.clear = previous.original.clear;
		}
	}

	const original = {
		addChild:
			previous && prototype.addChild === previous.installed?.addChild
				? previous.original.addChild
				: prototype.addChild,
		removeChild:
			previous && prototype.removeChild === previous.installed?.removeChild
				? previous.original.removeChild
				: prototype.removeChild,
		clear:
			previous && prototype.clear === previous.installed?.clear
				? previous.original.clear
				: prototype.clear,
	};

	const patch: Patch = {
		active: true,
		prototype,
		original,
		installed: undefined as any,
		groups: new Set(),
		enabled: getEnabled,
		generation: 0,
	};

	patch.installed = {
		addChild: function (this: any, component: any) {
			const result = patch.original.addChild.call(this, component);
			if (component && typeof component === "object") component[PARENT_KEY] = this;
			maybeGroup(patch, this, component);
			return result;
		},
		removeChild: function (this: any, component: any) {
			const group = component?.[PARENT_KEY];
			if (group instanceof ToolGroupComponent && (group as any)[PARENT_KEY] === this) {
				group.removeTool(component);
				normalizeGroup(patch, group);
				return;
			}
			const result = patch.original.removeChild.call(this, component);
			if (component?.[PARENT_KEY] === this) delete component[PARENT_KEY];
			if (this instanceof ToolGroupComponent) normalizeGroup(patch, this);
			if (component instanceof ToolGroupComponent) {
				for (const tool of component.releaseTools()) delete tool[PARENT_KEY];
			}
			return result;
		},
		clear: function (this: any) {
			for (const child of [...(this.children ?? [])]) {
				if (child instanceof ToolGroupComponent) {
					for (const tool of child.releaseTools()) delete tool[PARENT_KEY];
				}
				if (child?.[PARENT_KEY] === this) delete child[PARENT_KEY];
			}
			if (this instanceof ToolGroupComponent) patch.groups.delete(this);
			return patch.original.clear.call(this);
		},
	};

	prototype.addChild = patch.installed.addChild;
	prototype.removeChild = patch.installed.removeChild;
	prototype.clear = patch.installed.clear;
	(globalThis as any)[PATCH_KEY] = patch;

	return {
		setTheme(theme: ThemeLike) {
			patch.theme = theme;
		},
		shutdown() {
			if (!patch.active) return;
			patch.active = false;
			patch.enabled = () => false;
			ungroup(patch);
			if (prototype.addChild === patch.installed.addChild) {
				prototype.addChild = patch.original.addChild;
			}
			if (prototype.removeChild === patch.installed.removeChild) {
				prototype.removeChild = patch.original.removeChild;
			}
			if (prototype.clear === patch.installed.clear) {
				prototype.clear = patch.original.clear;
			}
		},
	};
}
