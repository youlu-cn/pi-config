/**
 * Lightweight consecutive-tool grouping for session-ui.
 *
 * Patches Container.addChild/removeChild/clear so consecutive same-category
 * ToolExecutionComponent instances (including across thinking-only assistant
 * turns with no visible prose) collapse into a single continuously-updating
 * ToolGroupComponent.
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	MouseRegion,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	buildGroupLines,
	classifyGroupCategory,
	type GroupTheme,
	type ToolCategory,
	type ToolSnapshot,
} from "./tool-grouping-core.ts";

const PARENT_KEY = Symbol.for("session-ui.toolGroup.parent");
const GENERATION_KEY = Symbol.for("session-ui.toolGroup.generation");
const PATCH_KEY = Symbol.for("session-ui.toolGrouping.patch");

type ThemeLike = GroupTheme;

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

function statusOf(tool: any): "pending" | "success" | "error" {
	if (!tool?.result) return "pending";
	if (tool.result.isError) return "error";
	return "success";
}

function statusIcon(status: "pending" | "success" | "error", theme: ThemeLike): string {
	if (status === "pending") return theme.fg("accent", "●");
	if (status === "error") return theme.fg("error", "●");
	return theme.fg("success", "●");
}

function isGroupable(value: unknown): boolean {
	if (!(value instanceof ToolExecutionComponent)) return false;
	return classifyGroupCategory(toolNameOf(value)) !== null;
}

function isSpacer(child: unknown): boolean {
	return typeof child === "object" && child !== null && (child as any).constructor?.name === "Spacer";
}

function isAssistantComponent(child: unknown): boolean {
	if (typeof child !== "object" || child === null) return false;
	return (
		child instanceof AssistantMessageComponent ||
		(child as any).constructor?.name === "AssistantMessageComponent"
	);
}

function hasVisibleAssistantText(child: any): boolean {
	const msg = child?.lastMessage;
	if (!msg || !Array.isArray(msg.content)) return true;
	return msg.content.some(
		(block: any) =>
			block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
}

type PriorTarget =
	| { kind: "group"; group: ToolGroupComponent; index: number; crossedBridge: boolean }
	| { kind: "tool"; tool: any; index: number; crossedBridge: boolean };

function findMergeTarget(
	children: readonly unknown[],
	from: number,
	patch: Patch,
	category: ToolCategory,
): PriorTarget | undefined {
	let crossedBridge = false;
	for (let i = from; i >= 0; i--) {
		const child = children[i];
		if (child == null || isSpacer(child)) continue;

		if (isAssistantComponent(child) && !hasVisibleAssistantText(child)) {
			crossedBridge = true;
			continue;
		}

		if (child instanceof ToolGroupComponent && child.isSamePatch(patch)) {
			if (child.category === category) {
				return { kind: "group", group: child, index: i, crossedBridge };
			}
			return undefined;
		}

		if (
			isGroupable(child) &&
			(child as any)[GENERATION_KEY] === patch.generation &&
			classifyGroupCategory(toolNameOf(child)) === category
		) {
			return { kind: "tool", tool: child, index: i, crossedBridge };
		}

		return undefined;
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
	private lastRenderWidth = 80;
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

	get category(): ToolCategory | null {
		if (this.tools.length === 0) return null;
		return classifyGroupCategory(toolNameOf(this.tools[0]));
	}

	isSamePatch(other: Patch): boolean {
		return this.patch === other;
	}

	addTool(tool: any): void {
		this.tools.push(tool);
		tool[PARENT_KEY] = this;
		this.rebuild(this.lastRenderWidth);
	}

	removeTool(tool: any): void {
		const index = this.tools.indexOf(tool);
		if (index >= 0) this.tools.splice(index, 1);
		if (tool?.[PARENT_KEY] === this) delete tool[PARENT_KEY];
		this.rebuild(this.lastRenderWidth);
	}

	releaseTools(): any[] {
		const released = [...this.tools];
		this.tools.length = 0;
		this.patch.groups.delete(this);
		this.rebuild(this.lastRenderWidth);
		return released;
	}

	setExpanded(expanded: boolean): void {
		this._expanded = expanded;
		for (const tool of this.tools) {
			(tool as { setExpanded?: (v: boolean) => void }).setExpanded?.(expanded);
		}
		this.rebuild(this.lastRenderWidth);
	}

	invalidate(): void {
		this.rebuild(this.lastRenderWidth);
		for (const child of this.tools) (child as Component).invalidate?.();
	}

	private rebuild(width: number): void {
		this.view.clear();
		const theme = this.patch.theme ?? {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
		};
		const snapshots: ToolSnapshot[] = this.tools.map((tool) => ({
			toolName: toolNameOf(tool),
			args: tool?.args,
			cwd: typeof tool?.cwd === "string" ? tool.cwd : "",
			result: tool?.result,
			isPartial: tool?.isPartial,
		}));

		const lines = buildGroupLines(snapshots, theme, this._expanded, width);
		for (const line of lines) {
			this.view.addChild(new Text(line, 0, 0));
		}

		if (!this._expanded) return;

		const childWidth = Math.max(20, width - 3);
		for (let i = 0; i < this.tools.length; i++) {
			const tool = this.tools[i];
			const branch = i === this.tools.length - 1 ? "└" : "├";
			const st = statusOf(tool);
			const label = capitalize(toolNameOf(tool));
			this.view.addChild(
				new Text(` ${theme.fg("dim", branch)} ${statusIcon(st, theme)} ${label}`, 0, 0),
			);
			try {
				const childLines = (tool as Component).render?.(childWidth) ?? [];
				for (const row of childLines) {
					this.view.addChild(new Text(`   ${row}`, 0, 0));
				}
			} catch {
				/* ignore */
			}
		}
	}

	render(width: number): string[] {
		if (width > 0) this.lastRenderWidth = width;
		// Ensure header and aggregated rows reflect latest tool statuses before paint.
		this.rebuild(width > 0 ? width : this.lastRenderWidth);
		const lines = super.render(width);
		if (width <= 0) return lines;
		return lines.map((line) =>
			visibleWidth(line) > width ? truncateToWidth(line, width) : line,
		);
	}
}

function maybeGroup(patch: Patch, parent: any, component: any): void {
	if (!patch.active || !patch.enabled() || parent instanceof ToolGroupComponent) return;
	if (!isGroupable(component)) return;
	const category = classifyGroupCategory(toolNameOf(component));
	if (!category) return;

	component[GENERATION_KEY] = patch.generation;
	const children = parent?.children;
	if (!Array.isArray(children)) return;
	const index = children.indexOf(component);
	if (index < 0) return;

	const prior = findMergeTarget(children, index - 1, patch, category);
	if (!prior) return;

	if (prior.kind === "group") {
		if (!prior.crossedBridge) {
			children.splice(index, 1);
			prior.group.addTool(component);
			return;
		}
		// Move the group to the latest position so it updates in place at the bottom.
		children.splice(prior.index, 1);
		const newIndex = children.indexOf(component);
		if (newIndex >= 0) {
			children[newIndex] = prior.group;
		}
		(prior.group as any)[PARENT_KEY] = parent;
		prior.group.addTool(component);
		return;
	}

	const group = new ToolGroupComponent(patch);
	group.addTool(prior.tool);
	group.addTool(component);
	(group as any)[PARENT_KEY] = parent;

	if (!prior.crossedBridge) {
		children.splice(index, 1);
		children[prior.index] = group;
		return;
	}

	children.splice(prior.index, 1);
	const newIndex = children.indexOf(component);
	if (newIndex >= 0) {
		children[newIndex] = group;
	}
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
