import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Provider = "openai" | "openai-codex";
type Preferences = Partial<Record<Provider, boolean>>;
type Config = { enabled: boolean; showStatus: boolean };
type Model = ExtensionContext["model"];

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (object(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function readConfig(path: string): Config {
	const value = readJson(path);
	if (value === undefined) return { enabled: false, showStatus: true };
	if (!object(value) || Object.entries(value).some(
		([key, flag]) => (key !== "enabled" && key !== "showStatus") || typeof flag !== "boolean",
	)) throw new Error("Invalid Fast configuration");
	return { enabled: value.enabled === true, showStatus: value.showStatus !== false };
}

function readPreferences(path: string): Preferences {
	const value = readJson(path);
	if (value === undefined) return {};
	if (!object(value) || Object.entries(value).some(
		([key, flag]) => (key !== "openai" && key !== "openai-codex") || typeof flag !== "boolean",
	)) throw new Error("Invalid Fast preferences");
	const preferences: Preferences = {};
	if (typeof value.openai === "boolean") preferences.openai = value.openai;
	if (typeof value["openai-codex"] === "boolean") preferences["openai-codex"] = value["openai-codex"];
	return preferences;
}

function eligibleProvider(ctx: ExtensionContext, model: Model): Provider | undefined {
	if (!model) return undefined;
	const { provider, api } = model;
	if (
		((provider === "openai" && api === "openai-responses") ||
			(provider === "openai-codex" && api === "openai-codex-responses")) &&
		ctx.modelRegistry.isUsingOAuth(model)
	) return provider;
	return undefined;
}

export function registerFast(pi: ExtensionAPI, configPath: string, statePath: string): void {
	let config: Config | undefined;
	let preferences: Preferences = {};

	function enabled(provider: Provider): boolean {
		return config !== undefined && (preferences[provider] ?? config.enabled);
	}

	function updateBadge(ctx: ExtensionContext, model: Model = ctx.model): void {
		if (!ctx.hasUI) return;
		const provider = eligibleProvider(ctx, model);
		ctx.ui.setStatus("fast", config?.showStatus && provider && enabled(provider) ? "fast" : undefined);
	}

	function save(provider: Provider, value: boolean): void {
		const next = { ...readPreferences(statePath), [provider]: value };
		mkdirSync(dirname(statePath), { recursive: true });
		const temp = `${statePath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
			renameSync(temp, statePath);
		} finally {
			rmSync(temp, { force: true });
		}
		preferences = next;
	}

	pi.on("session_start", (_event, ctx) => {
		config = undefined;
		preferences = {};
		try {
			const settings = readConfig(configPath);
			preferences = readPreferences(statePath);
			config = settings;
		} catch {
			const warning = "Fast disabled: cannot read fast.json or state/fast.json. Fix the file and /reload.";
			if (ctx.hasUI) ctx.ui.notify(warning, "warning");
			else console.error(warning);
		}
		updateBadge(ctx);
	});

	pi.on("model_select", (event, ctx) => updateBadge(ctx, event.model));
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("fast", undefined);
	});

	pi.on("before_provider_request", ({ payload }, ctx) => {
		const provider = eligibleProvider(ctx, ctx.model);
		if (!provider || !enabled(provider) || !object(payload) || payload.model !== ctx.model?.id) return;
		if (Object.hasOwn(payload, "service_tier")) return;
		return { ...payload, service_tier: "priority" };
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI/Codex priority requests: /fast [on|off|status]",
		getArgumentCompletions: (prefix) => ["on", "off", "status"]
			.filter((action) => action.startsWith(prefix))
			.map((action) => ({ value: action, label: action })),
		handler: async (args, ctx) => {
			const action = args.trim();
			if (!["", "on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}
			const provider = eligibleProvider(ctx, ctx.model);
			if (!provider || !config) {
				ctx.ui.notify(config
					? "Fast unavailable: select an OpenAI or Codex Responses model with ChatGPT OAuth."
					: "Fast unavailable: fix the configuration or state file and /reload.", "warning");
				return;
			}
			if (action !== "status") {
				try {
					save(provider, action === "" ? !enabled(provider) : action === "on");
				} catch {
					ctx.ui.notify("Fast switch was not saved; the current setting is unchanged.", "warning");
					return;
				}
				updateBadge(ctx);
			}
			ctx.ui.notify(enabled(provider) ? "Fast: on" : "Fast: off", "info");
		},
	});
}
