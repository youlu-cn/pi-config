import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

/**
 * Safely writes auth.json back to the active agent directory
 */
export function saveAuthStorage(data: Record<string, any>): void {
	try {
		const authPath = resolveAuthPath();
		writeFileSync(authPath, JSON.stringify(data, null, 2), "utf8");
	} catch {
		// Ignore write errors in restricted environments
	}
}

async function resolveOAuthClientCredentials(): Promise<{ clientId?: string; clientSecret?: string }> {
	if (process.env.ANTIGRAVITY_CLIENT_ID && process.env.ANTIGRAVITY_CLIENT_SECRET) {
		return {
			clientId: process.env.ANTIGRAVITY_CLIENT_ID,
			clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET,
		};
	}
	try {
		const mod: any = await import("pi-antigravity/auth");
		if (mod?.CLIENT_ID && mod?.CLIENT_SECRET) {
			return { clientId: mod.CLIENT_ID, clientSecret: mod.CLIENT_SECRET };
		}
	} catch {}
	return {};
}

export interface AntigravityCredential {
	token: string;
	projectId?: string;
	email?: string;
}

/**
 * Resolves Antigravity access token, auto-refreshing if expired
 */
export async function resolveAntigravityToken(): Promise<AntigravityCredential | undefined> {
	const auth = loadAuthStorage();
	const key = auth.antigravity ? "antigravity" : auth["google-antigravity"] ? "google-antigravity" : undefined;
	const entry = key ? auth[key] : undefined;

	if (!entry) {
		const envToken = process.env.ANTIGRAVITY_TOKEN;
		if (envToken) return { token: envToken };
		return undefined;
	}

	let token = entry.access || entry.access_token || entry.token;
	const email = entry.email;
	let projectId = entry.projectId;

	if (entry.apiKey && typeof entry.apiKey === "string") {
		try {
			const parsed = JSON.parse(entry.apiKey);
			if (parsed.token) token = parsed.token;
			if (parsed.projectId) projectId = parsed.projectId;
		} catch {}
	}

	const now = Date.now();
	const expires = typeof entry.expires === "number" ? entry.expires : 0;
	const refresh = entry.refresh || entry.refresh_token;

	// Token expired or about to expire in 1 minute -> refresh using refresh_token
	if (refresh && (!token || (expires > 0 && now > expires - 60_000))) {
		try {
			const oauthCreds = await resolveOAuthClientCredentials();
			if (oauthCreds.clientId && oauthCreds.clientSecret) {
				const res = await fetch("https://oauth2.googleapis.com/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						client_id: oauthCreds.clientId,
						client_secret: oauthCreds.clientSecret,
						refresh_token: refresh,
						grant_type: "refresh_token",
					}).toString(),
				});
				if (res.ok) {
					const data = (await res.json()) as { access_token?: string; expires_in?: number };
					if (data.access_token) {
						token = data.access_token;
						entry.access = token;
						if (typeof data.expires_in === "number") {
							entry.expires = now + data.expires_in * 1000 - 5 * 60 * 1000;
						}
						saveAuthStorage(auth);
					}
				}
			}
		} catch {}
	}

	if (!token) return undefined;
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
