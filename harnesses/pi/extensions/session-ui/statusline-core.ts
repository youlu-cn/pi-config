export type StatuslineOverflow = "drop-right" | "priority";

export interface StatuslineLayoutItem {
	id: string;
	priority: number;
	required: boolean;
	value: string;
	width: number;
	compactValue?: string;
	compactWidth?: number;
}

export type SubscriptionUsageWindowKind =
	| "hourly"
	| "weekly"
	| "monthly"
	| "rolling"
	| "quota";

export type SubscriptionUsageDisplayMode = "remaining" | "used";

export interface SubscriptionUsageWindowView {
	kind: SubscriptionUsageWindowKind;
	label: string;
	remainingPercent: number;
	usedPercent: number;
	displayPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
	resetCountdown?: string;
}

export interface SubscriptionUsageView {
	providerId: string;
	capturedAt: number;
	displayMode: SubscriptionUsageDisplayMode;
	windows: SubscriptionUsageWindowView[];
}

export type StatuslineSeparatorWidth =
	| number
	| ((left: StatuslineLayoutItem, right: StatuslineLayoutItem) => number);

function totalWidth(
	items: readonly StatuslineLayoutItem[],
	separatorWidth: StatuslineSeparatorWidth,
): number {
	let width = items.reduce((total, item) => total + item.width, 0);
	for (let index = 1; index < items.length; index++) {
		width +=
			typeof separatorWidth === "number"
				? separatorWidth
				: separatorWidth(items[index - 1]!, items[index]!);
	}
	return width;
}

/** Selects and optionally compacts statusline items without knowing about ANSI. */
export function fitStatuslineItems(
	items: readonly StatuslineLayoutItem[],
	width: number,
	separatorWidth: StatuslineSeparatorWidth,
	overflow: StatuslineOverflow,
): StatuslineLayoutItem[] {
	if (width <= 0 || items.length === 0) return [];
	const active = items.map((item) => ({ ...item }));

	if (overflow === "drop-right") {
		for (let count = active.length; count >= 1; count--) {
			const prefix = active.slice(0, count);
			if (totalWidth(prefix, separatorWidth) <= width) return prefix;
		}
		return [active[0]!];
	}

	if (totalWidth(active, separatorWidth) <= width) return active;
	const lowPriorityFirst = [...active].sort((a, b) => a.priority - b.priority);

	for (const candidate of lowPriorityFirst) {
		if (
			candidate.compactValue === undefined ||
			candidate.compactWidth === undefined ||
			candidate.compactValue === candidate.value
		) {
			continue;
		}
		candidate.value = candidate.compactValue;
		candidate.width = candidate.compactWidth;
		if (totalWidth(active, separatorWidth) <= width) return active;
	}

	for (const candidate of lowPriorityFirst) {
		if (candidate.required) continue;
		const index = active.findIndex((item) => item.id === candidate.id);
		if (index >= 0) active.splice(index, 1);
		if (totalWidth(active, separatorWidth) <= width) return active;
	}

	return active;
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

export function separatorBetweenStatuslineSegments(
	leftId: string,
	rightId: string,
	defaultSeparator: string,
): string {
	const usesSpace =
		(leftId === "model" && rightId === "effort") ||
		(leftId === "effort" && rightId === "model") ||
		(leftId === "directory" && rightId === "branch") ||
		(leftId === "branch" && rightId === "directory");
	return usesSpace ? " " : defaultSeparator;
}

/** Matches an extension status id; `*` is the only wildcard. */
export function matchesStatusPattern(id: string, pattern: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => escapeRegexLiteral(part))
		.join(".*");
	return new RegExp(`^${source}$`).test(id);
}

export function isExtensionStatusExcluded(
	id: string,
	patterns: readonly string[],
): boolean {
	return patterns.some((pattern) => matchesStatusPattern(id, pattern));
}

export function findUnknownStatusSegments(
	configured: readonly string[],
	registered: ReadonlySet<string>,
): string[] {
	return configured.filter((id) => !registered.has(id));
}

function sanitizeStatusText(value: string): string {
	return value
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function isSubscriptionUsageWindowKind(
	value: unknown,
): value is SubscriptionUsageWindowKind {
	return (
		value === "hourly" ||
		value === "weekly" ||
		value === "monthly" ||
		value === "rolling" ||
		value === "quota"
	);
}

function isUsagePercent(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
	);
}

function subscriptionUsageWindowRank(
	kind: SubscriptionUsageWindowKind,
): number {
	if (kind === "hourly" || kind === "rolling") return 0;
	if (kind === "weekly") return 1;
	if (kind === "monthly") return 2;
	return 3;
}

/** Decodes the subscription-usage v1 event at the extension boundary. */
export function parseSubscriptionUsageEvent(
	data: unknown,
): SubscriptionUsageView | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const snapshot = data as {
		v?: unknown;
		status?: unknown;
		providerId?: unknown;
		capturedAt?: unknown;
		displayMode?: unknown;
		windows?: unknown;
	};
	if (
		snapshot.v !== 1 ||
		snapshot.status !== "ready" ||
		typeof snapshot.providerId !== "string" ||
		typeof snapshot.capturedAt !== "number" ||
		!Number.isFinite(snapshot.capturedAt) ||
		!Array.isArray(snapshot.windows)
	) {
		return undefined;
	}
	const providerId = sanitizeStatusText(snapshot.providerId);
	if (!providerId || providerId.length > 80) return undefined;
	const displayMode: SubscriptionUsageDisplayMode | undefined =
		snapshot.displayMode === undefined || snapshot.displayMode === "remaining"
			? "remaining"
			: snapshot.displayMode === "used"
				? "used"
				: undefined;
	if (!displayMode) return undefined;
	const windows = snapshot.windows
		.flatMap((entry): SubscriptionUsageWindowView[] => {
			if (typeof entry !== "object" || entry === null) return [];
			const candidate = entry as {
				kind?: unknown;
				label?: unknown;
				remainingPercent?: unknown;
				usedPercent?: unknown;
				displayPercent?: unknown;
				windowMinutes?: unknown;
				resetsAt?: unknown;
				resetCountdown?: unknown;
			};
			if (
				!isSubscriptionUsageWindowKind(candidate.kind) ||
				typeof candidate.label !== "string" ||
				!isUsagePercent(candidate.remainingPercent) ||
				(candidate.usedPercent !== undefined &&
					!isUsagePercent(candidate.usedPercent)) ||
				(candidate.displayPercent !== undefined &&
					!isUsagePercent(candidate.displayPercent))
			) {
				return [];
			}
			const label = sanitizeStatusText(candidate.label);
			if (!label || label.length > 16) return [];
			if (
				candidate.windowMinutes !== undefined &&
				(typeof candidate.windowMinutes !== "number" ||
					!Number.isFinite(candidate.windowMinutes) ||
					candidate.windowMinutes <= 0)
			) {
				return [];
			}
			if (
				candidate.resetsAt !== undefined &&
				(typeof candidate.resetsAt !== "number" ||
					!Number.isFinite(candidate.resetsAt) ||
					candidate.resetsAt <= 0)
			) {
				return [];
			}
			// The countdown is display-only; a malformed value drops the field, not the window.
			const resetCountdown =
				typeof candidate.resetCountdown === "string"
					? sanitizeStatusText(candidate.resetCountdown)
					: "";
			const usedPercent =
				candidate.usedPercent ?? 100 - candidate.remainingPercent;
			const displayPercent =
				candidate.displayPercent ??
				(displayMode === "used" ? usedPercent : candidate.remainingPercent);
			return [
				{
					kind: candidate.kind,
					label,
					remainingPercent: candidate.remainingPercent,
					usedPercent,
					displayPercent,
					...(candidate.windowMinutes === undefined
						? {}
						: { windowMinutes: candidate.windowMinutes }),
					...(candidate.resetsAt === undefined
						? {}
						: { resetsAt: candidate.resetsAt }),
					...(resetCountdown && resetCountdown.length <= 16
						? { resetCountdown }
						: {}),
				},
			];
		})
		.sort((left, right) => {
			const rank =
				subscriptionUsageWindowRank(left.kind) -
				subscriptionUsageWindowRank(right.kind);
			if (rank !== 0) return rank;
			const duration =
				(left.windowMinutes ?? Number.POSITIVE_INFINITY) -
				(right.windowMinutes ?? Number.POSITIVE_INFINITY);
			return duration === 0 ? left.label.localeCompare(right.label) : duration;
		});
	if (windows.length === 0) return undefined;
	return {
		providerId,
		capturedAt: snapshot.capturedAt,
		displayMode,
		windows,
	};
}
