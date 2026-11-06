import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(path: string): JsonObject {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return {};
		throw error;
	}
	if (!isObject(raw)) throw new Error("state root must be an object");
	if (raw.workAnimation !== undefined) {
		if (!isObject(raw.workAnimation)) {
			throw new Error("workAnimation must be an object");
		}
		if (
			raw.workAnimation.enabled !== undefined &&
			typeof raw.workAnimation.enabled !== "boolean"
		) {
			throw new Error("workAnimation.enabled must be a boolean");
		}
	}
	return raw;
}

export function loadWorkAnimationState(
	path: string,
	fallback: boolean,
): { enabled: boolean; warning?: string } {
	try {
		const raw = readState(path);
		const animation = raw.workAnimation as JsonObject | undefined;
		return { enabled: (animation?.enabled as boolean | undefined) ?? fallback };
	} catch (error) {
		return {
			enabled: fallback,
			warning: `session-ui state (${path}): ${error instanceof Error ? error.message : String(error)}; using configured work animation default (${fallback ? "on" : "off"})`,
		};
	}
}

export function saveWorkAnimationState(path: string, enabled: boolean): void {
	// Re-read before writing so unrelated state is preserved.
	const raw = readState(path);
	const next = {
		...raw,
		workAnimation: { ...(raw.workAnimation as JsonObject | undefined), enabled },
	};
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.tmp-${randomUUID()}`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}
