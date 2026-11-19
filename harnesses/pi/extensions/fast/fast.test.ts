import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFast } from "./runtime.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.2-astra" };
const openai = { provider: "openai", api: "openai-responses", id: "gpt-6.2-astra" };

function setup(t: TestContext, config?: unknown) {
	const dir = mkdtempSync(join(tmpdir(), "pi-fast-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "fast.json");
	const statePath = join(dir, "state", "fast.json");
	if (config !== undefined) writeFileSync(configPath, JSON.stringify(config));
	const events = new Map<string, (event: any, context: any) => unknown>();
	let handler: (args: string, context: any) => Promise<void>;
	let oauth = true;
	const messages: string[] = [];
	const badge = new Map<string, string | undefined>();
	const ctx = {
		model: codex,
		hasUI: true,
		modelRegistry: { isUsingOAuth: () => oauth },
		ui: {
			setStatus: (key: string, value?: string) => badge.set(key, value),
			notify: (text: string) => messages.push(text),
		},
	};
	registerFast({
		on: (key: string, fn: (event: any, context: any) => unknown) => events.set(key, fn),
		registerCommand: (name: string, command: { handler: typeof handler }) => {
			assert.equal(name, "fast");
			handler = command.handler;
		},
	} as unknown as ExtensionAPI, configPath, statePath);
	const emit = (name: string, event = {}) => events.get(name)!(event, ctx);
	emit("session_start");
	return {
		badge, messages, statePath, emit,
		command: (args: string) => handler(args, ctx),
		request: (payload: unknown) => emit("before_provider_request", { payload }),
		select(model: typeof codex, useOAuth = true) {
			oauth = useOAuth;
			ctx.model = model;
			emit("model_select", { model });
		},
	};
}

const payload = { model: codex.id, input: [] };

test("Codex Fast is opt-in, updates the badge and preserves explicit tiers", async (t) => {
	const app = setup(t);
	assert.equal(app.request(payload), undefined);
	await app.command("");
	assert.equal(app.badge.get("fast"), "fast");
	assert.deepEqual(app.request(payload), { ...payload, service_tier: "priority" });
	assert.equal(Object.hasOwn(payload, "service_tier"), false);
	for (const unchanged of [{ ...payload, service_tier: "default" }, { model: "different" }, null, []]) {
		assert.equal(app.request(unchanged), undefined);
	}
	await app.command("off");
	assert.equal(app.request(payload), undefined);
	assert.equal(app.badge.get("fast"), undefined);
});

test("provider switches persist independently and status does not write", async (t) => {
	const app = setup(t);
	await app.command("on");
	app.select(openai);
	await app.command("status");
	assert.equal(app.messages.at(-1), "Fast: off");
	assert.deepEqual(JSON.parse(readFileSync(app.statePath, "utf8")), { "openai-codex": true });
	await app.command("off");
	app.emit("session_start");
	assert.equal(app.request(payload), undefined);
	app.select(codex);
	assert.equal(app.badge.get("fast"), "fast");
	assert.deepEqual(JSON.parse(readFileSync(app.statePath, "utf8")), { "openai-codex": true, openai: false });
	app.emit("session_shutdown");
	assert.equal(app.badge.get("fast"), undefined);
});

test("no mutation for API-key auth, mismatched APIs or other providers", async (t) => {
	const app = setup(t, { enabled: true, showStatus: false });
	app.select(openai);
	assert.deepEqual(app.request(payload), { ...payload, service_tier: "priority" });
	assert.equal(app.badge.get("fast"), undefined);
	app.select(codex, false);
	await app.command("status");
	assert.match(app.messages.at(-1)!, /unavailable/);
	assert.equal(app.request(payload), undefined);
	for (const model of [{ ...openai, api: "openai-completions" }, { ...openai, provider: "xai" }]) {
		app.select(model);
		assert.equal(app.request(payload), undefined);
	}
});

test("invalid config and failed persistence do not enable Fast", async (t) => {
	const invalid = setup(t, { enabled: "true" });
	assert.match(invalid.messages.at(-1)!, /Fast disabled/);
	assert.equal(invalid.request(payload), undefined);
	const app = setup(t);
	mkdirSync(app.statePath, { recursive: true });
	await app.command("on");
	assert.match(app.messages.at(-1)!, /not saved/);
	assert.equal(app.request(payload), undefined);
});
