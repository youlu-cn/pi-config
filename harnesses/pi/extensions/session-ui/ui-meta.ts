import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionUiConfig } from "./config.ts";
import {
	extractUiMetaRecords,
	sanitizeUiMetaText,
	stripUiMetaBlocks,
	UI_META_SENTINEL,
	type UiMetaLimits,
	type UiMetaRecord,
} from "./ui-meta-core.ts";
import type { SessionTitleController } from "./title-controller.ts";

const UI_META_STATE_TYPE = "session-ui:ui-meta-state";

type UiMetaConfig = SessionUiConfig["uiMeta"];

interface UiMetaStateData {
	v: 1;
	title?: string;
}

function isAssistantMessage(
	message: AgentMessage,
): message is AssistantMessage {
	return "role" in message && message.role === "assistant";
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
		.join("\n");
}

function stripMessageMetadata(
	message: AssistantMessage,
): AssistantMessage | undefined {
	let changed = false;
	const content: AssistantMessage["content"] = [];
	for (const entry of message.content) {
		if (entry.type !== "text") {
			content.push(entry);
			continue;
		}

		const text = stripUiMetaBlocks(entry.text, true);
		if (text === entry.text) {
			content.push(entry);
			continue;
		}

		changed = true;
		if (text) content.push({ type: "text", text });
	}
	return changed ? { ...message, content } : undefined;
}

function buildProtocolPrompt(config: UiMetaConfig): string {
	const startEnabled = config.title.enabled || config.sessionName.enabled;
	const startExample = JSON.stringify({
		v: 1,
		kind: "turn_start",
		...(config.title.enabled ? { title: "..." } : {}),
		...(config.sessionName.enabled ? { session: { action: "set", name: "..." } } : {}),
	});
	return `# Session UI metadata protocol
Metadata is optional display-only output alongside your normal answer. Most confirmations, follow-up questions and routine progress need no metadata. Omission means keep the existing UI; never add a record just to satisfy a cadence. Do not output task identifiers or keep/skip records.

${startEnabled
		? `Only in the first assistant message responding to a real user request, you may prepend one single-line ${UI_META_SENTINEL}${startExample} record before prose or tool calls. Omit unchanged or irrelevant fields:
${config.title.enabled
			? `- "title": a concise current activity, at most ${config.title.maxLength} visible characters. Propose it when a clear activity first emerges (discussion counts), or substantive work begins or changes. Do not retitle routine confirmations, refinements, tool continuations or background notifications.`
			: "- Do not include title; title metadata is disabled."}
${config.sessionName.enabled
			? `- "session":{"action":"set","name":"..."}: a stable high-level session goal, at most ${config.sessionName.maxLength} visible characters. Propose a name when the first clear goal emerges, not every turn. The application only names unnamed sessions and preserves every existing name, including manual names.`
			: "- Do not include session; automatic naming is disabled."}`
		: "Do not emit turn_start metadata; title and automatic naming are disabled."}

Put records on their own physical lines, with no XML tags, closing marker, code fences or explanation. Use the latest real user's language and no trailing punctuation. Exclude secrets, credentials, full paths and terminal control characters. Do not repeat start metadata after tool results. Metadata must not alter, delay or replace the normal answer.`;
}

export function registerUiMeta(
	pi: ExtensionAPI,
	config: UiMetaConfig,
	titleController: SessionTitleController,
): void {
	const limits: UiMetaLimits = {
		title: config.title.maxLength,
		sessionName: config.sessionName.maxLength,
	};
	const protocolPrompt = buildProtocolPrompt(config);
	const startMetadataEnabled = config.title.enabled || config.sessionName.enabled;

	let enabledForSession = false;
	let requestActive = false;
	let startOpen = false;
	let continueAfterCompaction = false;
	let currentTitle = "";
	let stateDirty = false;

	const resetRun = () => {
		requestActive = false;
		startOpen = false;
		continueAfterCompaction = false;
	};

	const restoreState = (ctx: ExtensionContext) => {
		currentTitle = "";
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
			if (entry.customType === UI_META_STATE_TYPE) {
				const data = entry.data as Partial<UiMetaStateData>;
				if (data.v !== 1) continue;
				currentTitle = typeof data.title === "string"
					? sanitizeUiMetaText(data.title, limits.title) : "";
				break;
			}
		}
		stateDirty = false;
		titleController.setTaskTitle(config.title.enabled ? currentTitle : "");
	};

	const flushPendingEntries = () => {
		if (!stateDirty) return;
		pi.appendEntry<UiMetaStateData>(UI_META_STATE_TYPE, {
			v: 1,
			...(currentTitle ? { title: currentTitle } : {}),
		});
		stateDirty = false;
	};

	const applyStart = (records: UiMetaRecord[]) => {
		if (!startOpen) return;
		startOpen = false;
		const record = records.find((record) => record.kind === "turn_start");
		if (!record || record.kind !== "turn_start") return;
		if (config.title.enabled && record.title && record.title !== currentTitle) {
			currentTitle = record.title;
			stateDirty = true;
			titleController.setTaskTitle(currentTitle);
		}
		// Naming is one-shot while a name exists; manual naming never blocks titles.
		if (config.sessionName.enabled && record.session?.action === "set" && !pi.getSessionName()?.trim()) {
			pi.setSessionName(record.session.name);
		}
	};

	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant") return markdown;
		return stripUiMetaBlocks(markdown, context.isStreaming);
	});

	pi.on("session_start", (_event, ctx) => {
		enabledForSession = ctx.mode === "tui" && config.enabled && startMetadataEnabled;
		resetRun();
		if (enabledForSession) restoreState(ctx);
	});

	pi.on("before_agent_start", (event) => {
		if (!enabledForSession) return;
		flushPendingEntries();
		const continuation = continueAfterCompaction && requestActive;
		continueAfterCompaction = false;
		if (!continuation) {
			resetRun();
			startOpen = startMetadataEnabled && event.messageType === "user";
		}
		requestActive = true;
		titleController.setWorking(true);
		// Keep this section identical for user/custom runs. Never rewrite user history
		// or inject live UI state into the request; Pi persists only section changes.
		event.systemPromptOptions.sections.session_ui_meta = protocolPrompt;
	});

	pi.on("message_end", (event) => {
		if (!enabledForSession || !isAssistantMessage(event.message)) return;
		const message = event.message;
		const text = assistantText(message);
		// Commit only finalized successful messages, never speculative streaming data.
		if (requestActive && (message.stopReason === "stop" || message.stopReason === "toolUse")) {
			const records = extractUiMetaRecords(text, limits);
			applyStart(records);
		}
		const replacement = stripMessageMetadata(message);
		return replacement ? { message: replacement } : undefined;
	});

	pi.on("agent_end", () => {
		if (enabledForSession) flushPendingEntries();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!enabledForSession || !ctx.isIdle()) return;
		flushPendingEntries();
		resetRun();
		titleController.setWorking(false);
	});

	pi.on("session_compact", (event) => {
		if (enabledForSession && requestActive) continueAfterCompaction = event.willRetry;
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!enabledForSession) return;
		// Never flush pending data from the branch we just left.
		resetRun();
		restoreState(ctx);
	});

	pi.on("session_shutdown", () => {
		if (enabledForSession) flushPendingEntries();
		resetRun();
		stateDirty = false;
		currentTitle = "";
		titleController.setWorking(false);
		enabledForSession = false;
	});
}
