import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
}

/**
 * Safely loads auth.json from the active agent directory
 */
export function loadAuthStorage(): Record<string, any> {
	try {
		const authPath = join(resolveAgentDir(), "auth.json");
		if (!existsSync(authPath)) return {};
		const content = readFileSync(authPath, "utf8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

/**
 * Formats milliseconds remaining into human-readable countdown string (e.g. "4h 20m" or "35m")
 */
export function formatCountdown(ms: number): string {
	const clamped = Math.max(0, ms);
	const totalSeconds = Math.round(clamped / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);

	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	return `${minutes}m`;
}

/**
 * Creates an AbortSignal that aborts after timeoutMs or when parent signal fires
 */
export function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Timeout")), timeoutMs);

	let onParentAbort: (() => void) | undefined;
	if (parentSignal) {
		onParentAbort = () => controller.abort(parentSignal.reason);
		if (parentSignal.aborted) {
			controller.abort(parentSignal.reason);
		} else {
			parentSignal.addEventListener("abort", onParentAbort, { once: true });
		}
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			if (parentSignal && onParentAbort) {
				parentSignal.removeEventListener("abort", onParentAbort);
			}
		},
	};
}
