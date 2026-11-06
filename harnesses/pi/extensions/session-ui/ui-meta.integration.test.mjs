import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DEFAULT_SESSION_UI_CONFIG } from "./config.ts";
import { UI_META_SENTINEL } from "./ui-meta-core.ts";

const root = process.env.PI_PACKAGE_ROOT;
let registerUiMeta, ExtensionRunner, AgentSession, buildSystemPromptSections, diffSystemPromptSections;
if (root) {
	const load = (path) => import(pathToFileURL(resolve(root, path)).href);
	({ ExtensionRunner } = await load("dist/core/extensions/runner.js"));
	({ AgentSession } = await load("dist/core/agent-session.js"));
	({ buildSystemPromptSections, diffSystemPromptSections } = await load("dist/core/system-prompt.js"));
	({ registerUiMeta } = await import("./ui-meta.ts"));
}
const options = { skip: !root };
const meta = (record) => `${UI_META_SENTINEL}${JSON.stringify({ v: 1, ...record })}`;
const start = (title = "Current action", name) => ({
	kind: "turn_start", title, ...(name ? { session: { action: "set", name } } : {}),
});
const userTrigger = (prompt = "Request") => ({ messageType: "user", prompt });
const customMessage = () => ({ role: "custom", customType: "web-search-content-ready", content: "Content is ready", display: true, timestamp: 10 });

function harness({ entries = [], config = DEFAULT_SESSION_UI_CONFIG.uiMeta, name, mode = "tui" } = {}) {
	const handlers = new Map();
	const titles = [], working = [];
	let markdown;
	let branch = structuredClone(entries);
	let sessionName = name;
	const ctx = {
		mode,
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
	};
	const emit = (event, data = {}) => handlers.get(event)?.(data, ctx);
	const rename = (value) => { sessionName = value; emit("session_info_changed", { name: value }); };
	registerUiMeta({
		on: (event, handler) => handlers.set(event, handler),
		appendEntry: (customType, data) => branch.push({ type: "custom", customType, data: structuredClone(data) }),
		getSessionName: () => sessionName,
		setSessionName: rename,
		registerEntryRenderer: () => assert.fail("Title metadata must not register transcript renderers"),
		registerMarkdownTransformer: (transform) => { markdown = transform; },
	}, config, { setTaskTitle: (title) => titles.push(title), setWorking: (value) => working.push(value) });
	const raw = (text, stopReason = "stop", toolCalls = false, event = "message_end") => emit(event, {
		message: { role: "assistant", stopReason, content: [
			{ type: "text", text },
			...(toolCalls ? [{ type: "toolCall", id: "1", name: "test", arguments: {} }] : []),
		] },
	});
	emit("session_start");
	return {
		emit, handlers, ctx, titles, working, raw, rename,
		message: (records, stopReason, toolCalls) => raw(records.map(meta).join("\nAnswer\n"), stopReason, toolCalls),
		begin: (messageType = "user") => {
			const systemPromptOptions = { sections: {} };
			const trigger = messageType === "user" ? userTrigger() : { messageType: "custom", message: customMessage() };
			assert.equal(emit("before_agent_start", { ...trigger, systemPrompt: "Base", systemPromptOptions }), undefined);
			return systemPromptOptions;
		},
		end: () => { emit("agent_end"); emit("agent_settled"); },
		entries: () => branch,
		setBranch: (entries) => { branch = structuredClone(entries); emit("session_tree"); },
		newSession: () => { emit("session_shutdown"); branch = []; sessionName = undefined; emit("session_start"); },
		name: () => sessionName,
		markdown: (text, isStreaming = true) => markdown(text, { messageType: "assistant", isStreaming }),
	};
}

test("uses a title-only static protocol without task state or request markers", options, () => {
	const h = harness();
	const prompt = h.begin().sections.session_ui_meta;
	assert.match(prompt, /Metadata is optional/);
	assert.match(prompt, /Omission means keep/);
	assert.doesNotMatch(prompt, /recap|turn_end|ui_meta_request|needStart|currentTaskName/i);
	assert.equal(h.handlers.has("context"), false);
	assert.equal(h.handlers.has("context_with_system"), false);
	h.raw("Understood");
	h.end();
	assert.deepEqual(h.entries(), []);
	h.begin();
	h.message([start("Review implementation", "Review goal")]);
	assert.deepEqual(h.entries(), []);
	h.end();
	assert.deepEqual(h.entries().map((entry) => [entry.customType, entry.data]),
		[["session-ui:ui-meta-state", { v: 1, title: "Review implementation" }]]);
	assert.equal(h.begin().sections.session_ui_meta, prompt);
});

test("names only unnamed sessions and preserves titles on ordinary replies", options, () => {
	const h = harness();
	h.begin();
	h.message([start("Investigate", "Initial goal")]);
	h.end();
	h.begin();
	h.raw("Understood");
	h.end();
	assert.deepEqual(h.titles, ["", "Investigate"]);
	h.begin();
	h.message([start("Implement", "Another goal")]);
	h.end();
	assert.equal(h.name(), "Initial goal");
	assert.equal(h.titles.at(-1), "Implement");
	h.rename("Pinned name");
	h.begin();
	h.message([start("Verify", "Override")]);
	h.end();
	assert.equal(h.name(), "Pinned name");
	assert.equal(h.titles.at(-1), "Verify");
	h.rename(undefined);
	h.begin();
	h.message([start("Verify", "New explicit goal")]);
	h.end();
	assert.equal(h.name(), "New explicit goal");
	assert.deepEqual(h.titles, ["", "Investigate", "Implement", "Verify"]);
});

test("accepts independent title or name proposals without requiring keep records", options, () => {
	const h = harness({ name: "Existing name" });
	h.begin();
	h.message([start("Inspect", "Do not overwrite")]);
	h.end();
	assert.equal(h.name(), "Existing name");
	assert.equal(h.titles.at(-1), "Inspect");
	const other = harness();
	other.begin();
	other.message([{ kind: "turn_start", session: { action: "set", name: "Goal" } }]);
	other.end();
	assert.equal(other.name(), "Goal");
	assert.deepEqual(other.titles, [""]);
});

test("does not persist or diagnose unsupported end metadata", options, () => {
	const h = harness();
	h.begin();
	const replacement = h.raw(`Answer\n${meta({ kind: "turn_end", recap: "Unused" })}`);
	assert.deepEqual(replacement.message.content, [{ type: "text", text: "Answer" }]);
	h.end();
	assert.deepEqual(h.entries(), []);
	h.begin(); h.raw(`Answer\n${UI_META_SENTINEL}{bad}`); h.end();
	assert.deepEqual(h.entries(), []);
});

test("does not apply streaming, failed, late or repeated start metadata", options, () => {
	const h = harness();
	h.begin();
	h.raw(meta(start("Speculative", "Bad name")), "stop", false, "message_update");
	assert.deepEqual(h.titles, [""]);
	for (const reason of ["aborted", "error", "length"]) h.message([start("Failed", "Bad name")], reason);
	assert.equal(h.name(), undefined);
	h.message([start("Inspect", "Actual goal")], "toolUse", true);
	h.message([start("Tool continuation", "Override")], "toolUse", true);
	h.raw("Actual result");
	h.end();
	assert.deepEqual(h.titles, ["", "Inspect"]);
	const entries = structuredClone(h.entries());
	const stripped = h.raw(`${meta(start("Stale"))}\nAnswer`);
	h.end();
	assert.deepEqual(stripped.message.content, [{ type: "text", text: "Answer" }]);
	assert.deepEqual(h.titles, ["", "Inspect"]);
	assert.deepEqual(h.entries(), entries);
	h.begin();
	h.raw("A reply with no metadata", "toolUse", true);
	h.message([start("Too late")]);
	h.end();
	assert.equal(h.titles.at(-1), "Inspect");
});

test("preserves consumed title eligibility through compaction retry", options, () => {
	for (const runType of ["user", "custom"]) {
		const h = harness();
		h.begin(runType);
		h.message([start("Inspect")], "toolUse", true);
		h.emit("session_compact", { willRetry: true });
		h.emit("agent_end");
		h.begin("user");
		h.message([start("Repeated")]);
		h.end();
		assert.deepEqual(h.titles, runType === "user" ? ["", "Inspect"] : [""]);
	}
	const h = harness();
	h.begin();
	h.raw("Truncated", "length");
	h.emit("session_compact", { willRetry: true });
	h.begin();
	h.message([start("Recovered")]);
	h.end();
	assert.equal(h.titles.at(-1), "Recovered");
});

test("never changes titles or names during custom runs", options, () => {
	const h = harness();
	const prompt = h.begin("custom").sections.session_ui_meta;
	h.message([start("Background title", "Background name")]);
	h.end();
	assert.deepEqual(h.titles, [""]);
	assert.equal(h.name(), undefined);
	assert.deepEqual(h.entries(), []);
	assert.equal(h.begin().sections.session_ui_meta, prompt);
	h.message([start("Research", "Research sources")]);
	h.end();
	assert.equal(h.name(), "Research sources");
	assert.deepEqual(h.working, [true, false, true, false]);
});

test("restores branch-local titles without flushing abandoned state", options, () => {
	const h = harness({ name: "Pinned" });
	h.begin(); h.message([start("Task A")]); h.end();
	const branchA = structuredClone(h.entries());
	h.begin(); h.message([start("Task B")]); h.end();
	const restored = harness({ entries: h.entries(), name: h.name() });
	assert.equal(restored.titles.at(-1), "Task B");
	const count = restored.entries().length;
	restored.begin(); restored.message([start("Task B")]); restored.end();
	assert.equal(restored.entries().length, count);
	restored.begin(); restored.message([start("Uncommitted")]);
	restored.setBranch(branchA);
	restored.end();
	assert.deepEqual(restored.entries(), branchA);
	assert.equal(restored.titles.at(-1), "Task A");
	restored.begin(); restored.message([start("Task B")]); restored.end();
	assert.equal(restored.entries().at(-1).data.title, "Task B");
	restored.newSession();
	assert.equal(restored.titles.at(-1), "");
	restored.begin(); restored.message([start("Task B")]); restored.end();
	assert.equal(restored.entries().length, 1);
	assert.equal(restored.entries()[0].data.title, "Task B");
});

test("cleans boundary metadata while preserving normal text and tool content", options, () => {
	const h = harness();
	assert.equal(h.markdown(`Answer\n${UI_META_SENTINEL.slice(0, 8)}`), "Answer");
	assert.equal(h.markdown(`${meta(start())}\nAnswer`), "Answer");
	assert.equal(h.markdown('<ui_meta>{"v":1}</ui_meta>\nAnswer'), "Answer");
	h.begin();
	const result = h.raw(`${meta(start())}\nAnswer`, "toolUse", true);
	assert.equal(result.message.content[0].text, "Answer");
	assert.equal(result.message.content[1].type, "toolCall");
});

test("honors feature flags and leaves non-TUI sessions untouched", options, () => {
	const config = structuredClone(DEFAULT_SESSION_UI_CONFIG.uiMeta);
	const titleOnly = harness({ config: { ...config, sessionName: { ...config.sessionName, enabled: false } } });
	titleOnly.begin(); titleOnly.message([start("Inspect", "Ignored")]); titleOnly.end();
	assert.equal(titleOnly.name(), undefined);
	assert.equal(titleOnly.titles.at(-1), "Inspect");
	const nameOnly = harness({ config: { ...config, title: { ...config.title, enabled: false } } });
	nameOnly.begin(); nameOnly.message([start("Ignored", "Goal")]); nameOnly.end();
	assert.equal(nameOnly.name(), "Goal");
	assert.deepEqual(nameOnly.titles, [""]);
	assert.deepEqual(nameOnly.entries(), []);
	for (const other of [
		harness({ config: { ...config, enabled: false } }),
		harness({ config: { ...config, title: { ...config.title, enabled: false }, sessionName: { ...config.sessionName, enabled: false } } }),
		...["rpc", "print", "json"].map((mode) => harness({ mode })),
	]) {
		assert.deepEqual(other.begin(), { sections: {} });
		assert.equal(other.message([start("Ignored", "Ignored")]), undefined);
		other.end();
		assert.deepEqual(other.entries(), []);
		assert.deepEqual(other.titles, []);
		assert.equal(other.name(), undefined);
	}
});

// Installed Pi internals are test oracles only; keep these fixtures aligned on upgrades.
function nativeRunner(h, contextHandler) {
	const extensions = [{
		path: "session-ui",
		handlers: new Map([...h.handlers].map(([event, handler]) => [event, [handler]])),
	}];
	if (contextHandler) extensions.push({
		path: "tool-result-rewriter", handlers: new Map([["context", [contextHandler]]]),
	});
	const runner = new ExtensionRunner(extensions, {}, process.cwd(), {}, {});
	runner.createContext = () => h.ctx;
	runner.onError((error) => assert.fail(JSON.stringify(error)));
	return runner;
}

function requestTransform(runner, systemPromptOptions) {
	const host = {
		_runSystemPromptOptions: systemPromptOptions,
		agent: { transformContext: (messages) => runner.emitContext(messages) },
	};
	AgentSession.prototype._installAgentForcedPromptProjection.call(host);
	return host.agent.transformContext;
}

function transcript() {
	return [
		{ role: "system", content: "", sections: { preamble: "Base" }, toolsAdded: [
			{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
		], timestamp: 1 },
		{ role: "user", content: "Earlier request", timestamp: 2 },
		{ role: "system", content: "", sections: { project: "Updated project rules" }, toolsAdded: [
			{ name: "search", description: "Search files", parameters: { type: "object", properties: {} } },
		], timestamp: 3 },
		{ role: "user", content: [
			{ type: "text", text: "Current request" },
			{ type: "image", data: "test-image", mimeType: "image/png" },
		], timestamp: 4 },
		{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
			{ type: "text", text: "Large observation" },
		], isError: false, timestamp: 5 },
	];
}

test("keeps the entire prior input prefix across normal turns, tools and idle custom runs", options, async () => {
	const h = harness();
	const runner = nativeRunner(h);
	const base = { cwd: process.cwd(), customPrompt: "Base", selectedTools: [], sections: { other: "Keep" } };
	const first = await runner.emitBeforeAgentStart(userTrigger(), base);
	const sections = buildSystemPromptSections(first.systemPromptOptions);
	assert.equal(first.systemPromptOptions.forceSystemPrompt, undefined);
	assert.deepEqual(Object.keys(diffSystemPromptSections(buildSystemPromptSections(base), sections)), ["session_ui_meta"]);
	let history = transcript();
	const original = structuredClone(history);
	const firstInput = await requestTransform(runner, first.systemPromptOptions)(history);
	assert.deepEqual(firstInput, original);
	h.message([start("Inspect", "Goal")], "toolUse", true);
	history = [...history, { role: "toolResult", toolCallId: "call-2", toolName: "read", content: [{ type: "text", text: "More data" }], isError: false, timestamp: 6 }];
	assert.deepEqual((await requestTransform(runner, first.systemPromptOptions)(history)).slice(0, firstInput.length), firstInput);
	h.raw("Verified"); h.end();
	const beforeNextTurn = structuredClone(history);
	history.push({ role: "user", content: "Understood", timestamp: 7 });
	const second = await runner.emitBeforeAgentStart(userTrigger("Understood"), base);
	assert.equal(diffSystemPromptSections(sections, buildSystemPromptSections(second.systemPromptOptions)), undefined);
	assert.deepEqual((await requestTransform(runner, second.systemPromptOptions)(history)).slice(0, beforeNextTurn.length), beforeNextTurn);
	h.raw("Acknowledged"); h.end();
	const beforeCustom = structuredClone(history);
	await AgentSession.prototype.sendCustomMessage.call({
		isStreaming: false,
		async _startRun(trigger) {
			assert.equal(trigger.messageType, "custom");
			const next = await runner.emitBeforeAgentStart(trigger, base);
			assert.equal(diffSystemPromptSections(sections, buildSystemPromptSections(next.systemPromptOptions)), undefined);
			const input = await requestTransform(runner, next.systemPromptOptions)([...history, trigger.message]);
			assert.deepEqual(input.slice(0, beforeCustom.length), beforeCustom);
			assert.deepEqual(input.at(-1), trigger.message);
		},
	}, customMessage(), { triggerTurn: true });
	assert.deepEqual(base.sections, { other: "Keep" });
	assert.deepEqual(history.slice(0, original.length), original);
	assert.doesNotMatch(JSON.stringify(history), /ui_meta_request/);
});

test("busy custom notifications queue without reopening title eligibility", options, async () => {
	const h = harness(); h.begin(); h.message([start("Inspect")], "toolUse", true);
	let queued;
	await AgentSession.prototype.sendCustomMessage.call({
		isStreaming: true, agent: { steer: (message) => { queued = message; } },
		_startRun: () => assert.fail("Busy custom messages must queue"),
	}, customMessage(), { triggerTurn: true });
	assert.equal(queued.role, "custom");
	h.message([start("Background")]); h.end();
	assert.deepEqual(h.titles, ["", "Inspect"]);
});

test("preserves Pi prompt and tool restoration when another extension rewrites observations", options, async () => {
	const h = harness();
	const runner = nativeRunner(h, (event) => {
		assert.ok(event.messages.every((message) => message.role !== "system"));
		return { messages: event.messages.map((message) => message.role === "toolResult"
			? { ...message, content: [{ type: "text", text: "Observation placeholder" }] } : message) };
	});
	const { systemPromptOptions } = await runner.emitBeforeAgentStart(userTrigger(), { cwd: process.cwd() });
	const messages = transcript();
	const result = await requestTransform(runner, systemPromptOptions)(messages);
	assert.equal(result.filter((message) => message.role === "system").length, 1);
	assert.equal(result[0].sections.preamble, "Base");
	assert.equal(result[0].sections.project, "Updated project rules");
	assert.deepEqual(result[0].toolsAdded.map((tool) => tool.name), ["read", "search"]);
	assert.deepEqual(result.findLast((message) => message.role === "user"), messages[3]);
	assert.equal(result.at(-1).content[0].text, "Observation placeholder");
});

function preparePrompt(options, messages) {
	const host = { _toolRegistry: new Map(), _applyToolLoadout: AgentSession.prototype._applyToolLoadout, agent: { state: {} } };
	return AgentSession.prototype._preparePromptAndToolLoadout.call(host, options, messages);
}

test("persists one static section and recreates it after compaction without editing retained messages", options, async () => {
	const runner = nativeRunner(harness());
	const base = { cwd: process.cwd(), customPrompt: "Base", selectedTools: [] };
	const { systemPromptOptions } = await runner.emitBeforeAgentStart(userTrigger(), base);
	const retained = [
		{ role: "system", content: "", sections: buildSystemPromptSections(base), timestamp: 1 },
		{ role: "user", content: "Request or retained compaction summary", timestamp: 2 },
	];
	const patch = preparePrompt(systemPromptOptions, retained);
	assert.deepEqual(Object.keys(patch.sections), ["session_ui_meta"]);
	const history = [...retained, patch];
	assert.deepEqual(await requestTransform(runner, systemPromptOptions)(history), history);
	assert.equal(preparePrompt(systemPromptOptions, history), undefined);
	assert.deepEqual(preparePrompt(systemPromptOptions, retained).sections, patch.sections);
});

test("removes the protocol outside TUI and restores it on return", options, async () => {
	const base = { cwd: process.cwd(), customPrompt: "Base", selectedTools: [] };
	const tui = nativeRunner(harness());
	const { systemPromptOptions: tuiOptions } = await tui.emitBeforeAgentStart(userTrigger(), base);
	const history = [
		{ role: "system", content: "", sections: buildSystemPromptSections(tuiOptions), timestamp: 1 },
		{ role: "user", content: "Resume", timestamp: 2 },
	];
	for (const mode of ["rpc", "print", "json"]) {
		const runner = nativeRunner(harness({ mode }));
		const { systemPromptOptions } = await runner.emitBeforeAgentStart(userTrigger("Resume"), base);
		assert.equal(systemPromptOptions.sections.session_ui_meta, undefined);
		const removal = preparePrompt(systemPromptOptions, history);
		assert.deepEqual(removal.sections, { session_ui_meta: null });
		const resumed = [...history, removal];
		assert.deepEqual(await requestTransform(runner, systemPromptOptions)(resumed), resumed);
		assert.equal(preparePrompt(systemPromptOptions, resumed), undefined);
		assert.equal(preparePrompt(tuiOptions, resumed).sections.session_ui_meta, history[0].sections.session_ui_meta);
	}
});
