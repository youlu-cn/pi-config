import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function resolveAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
}

function resolveAuthPath(): string {
	return join(resolveAgentDir(), "auth.json");
}

/**
 * Safely loads auth.json from the active agent directory
 */
export function loadAuthStorage(): Record<string, any> {
	try {
		const authPath = resolveAuthPath();
		if (!existsSync(authPath)) return {};
		const content = readFileSync(authPath, "utf8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

export interface AntigravityCredential {
	token: string;
	projectId?: string;
	email?: string;
}

/**
 * Resolves login credential from Pi runtime or auth.json.
 * Returns undefined if the user has not logged in via Pi.
 */
export async function resolveAntigravityToken(
	ctx?: ExtensionContext,
): Promise<AntigravityCredential | undefined> {
	// 1. 优先尝试从 Pi 运行时 ModelRegistry 获取已登录凭据（Pi 自动管理 token 有效期）
	if (ctx?.modelRegistry?.getProviderAuth) {
		try {
			const res = await ctx.modelRegistry.getProviderAuth("antigravity");
			if (res?.auth) {
				let token: string | undefined;
				let projectId: string | undefined;

				// 检查 apiKey JSON
				if (typeof res.auth.apiKey === "string") {
					try {
						const parsed = JSON.parse(res.auth.apiKey);
						if (parsed.token) token = parsed.token;
						if (parsed.projectId) projectId = parsed.projectId;
					} catch {
						token = res.auth.apiKey;
					}
				}

				// 检查 headers Authorization
				if (!token && res.auth.headers) {
					const authHeader =
						res.auth.headers.Authorization || res.auth.headers.authorization;
					if (authHeader && authHeader.startsWith("Bearer ")) {
						token = authHeader.slice(7).trim();
					}
				}

				if (token) {
					const auth = loadAuthStorage();
					const entry = auth.antigravity || auth["google-antigravity"];
					return {
						token,
						projectId: projectId || entry?.projectId,
						email: entry?.email,
					};
				}
			}
		} catch {}
	}

	// 2. 从 Pi 登录成功后持久化的 auth.json 读取
	const auth = loadAuthStorage();
	const entry = auth.antigravity || auth["google-antigravity"];
	if (!entry) {
		return undefined;
	}

	let token = entry.access || entry.token;
	let projectId = entry.projectId;
	const email = entry.email;

	if (!token && entry.apiKey && typeof entry.apiKey === "string") {
		try {
			const parsed = JSON.parse(entry.apiKey);
			if (parsed.token) token = parsed.token;
			if (parsed.projectId) projectId = parsed.projectId;
		} catch {
			token = entry.apiKey;
		}
	}

	if (!token) {
		return undefined;
	}

	return { token, projectId, email };
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
