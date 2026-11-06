export type ActivityStatus = "running" | "done" | "error";

export interface CallCount {
	total: number;
	failed: number;
}

/** Nested rows carry `last` so the renderer can close the branch of each group. */
export type ActivityRow<T> =
	| { kind: "item"; value: T; nested: false; calls?: CallCount }
	| { kind: "item"; value: T; nested: true; last: boolean }
	| { kind: "more"; count: number; nested: true; last: boolean };

export interface ActivityLayout<T> {
	rows: ActivityRow<T>[];
	/** Top-level calls only; nested calls are summarized on their top-level call. */
	running: number;
	failed: number;
	hidden: number;
}

/**
 * Tool calls keyed by tool call id. Calls another tool made through `ctx.executeTool()`
 * (for example a codemode script) carry `parentToolCallId`. Nested calls can nest again,
 * so every nested call is grouped under its top-level call in start order.
 */
export class ActivityTree<T extends { status: ActivityStatus }> {
	private readonly values = new Map<string, T>();
	/** Top-level call id of every tracked call. */
	private readonly rootOf = new Map<string, string>();
	private readonly roots: string[] = [];
	private readonly nested = new Map<string, string[]>();

	start(id: string, value: T, parentId?: string): void {
		if (this.values.has(id)) {
			this.values.set(id, value);
			return;
		}
		this.values.set(id, value);
		// An untracked parent falls back to top level so the call stays visible.
		const root = parentId === undefined ? undefined : this.rootOf.get(parentId);
		if (root === undefined) {
			this.rootOf.set(id, id);
			this.roots.push(id);
			return;
		}
		this.rootOf.set(id, root);
		const group = this.nested.get(root);
		if (group) group.push(id);
		else this.nested.set(root, [id]);
	}

	get(id: string): T | undefined {
		return this.values.get(id);
	}

	clear(): void {
		this.values.clear();
		this.rootOf.clear();
		this.nested.clear();
		this.roots.splice(0, this.roots.length);
	}

	/**
	 * Shows the latest `maxRows` top-level calls, then spends the remaining rows on the
	 * latest nested calls, newest top-level call first. Omitted earlier nested calls
	 * collapse into one "more" row.
	 */
	layout(maxRows: number): ActivityLayout<T> {
		const shown = maxRows > 0 ? this.roots.slice(-maxRows) : [];
		let budget = maxRows - shown.length;
		const nestedRows = new Map<string, ActivityRow<T>[]>();
		for (const root of [...shown].reverse()) {
			const group = this.group(root);
			if (budget <= 0 || group.length === 0) continue;
			const kept = group.length <= budget ? group : group.slice(group.length - (budget - 1));
			const omitted = group.length - kept.length;
			const rows: ActivityRow<T>[] = [
				...(omitted > 0
					? [{ kind: "more" as const, count: omitted, nested: true as const, last: kept.length === 0 }]
					: []),
				...kept.map((value, index) => ({
					kind: "item" as const,
					value,
					nested: true as const,
					last: index === kept.length - 1,
				})),
			];
			budget -= rows.length;
			nestedRows.set(root, rows);
		}
		return {
			rows: shown.flatMap((root) => [this.rootRow(root), ...(nestedRows.get(root) ?? [])]),
			running: this.roots.filter((id) => this.values.get(id)?.status === "running").length,
			failed: this.roots.filter((id) => this.values.get(id)?.status === "error").length,
			hidden: this.roots.length - shown.length,
		};
	}

	private group(root: string): T[] {
		return (this.nested.get(root) ?? []).flatMap((id) => {
			const value = this.values.get(id);
			return value ? [value] : [];
		});
	}

	private rootRow(root: string): ActivityRow<T> {
		const value = this.values.get(root)!;
		const group = this.group(root);
		if (group.length === 0) return { kind: "item", value, nested: false };
		return {
			kind: "item",
			value,
			nested: false,
			calls: {
				total: group.length,
				failed: group.filter((call) => call.status === "error").length,
			},
		};
	}
}
