import type { AgentMessage, ExtensionContext, ModelSelectEvent } from "@earendil-works/pi-coding-agent";

export class ContextGuard {
	/**
	 * Maps deterministic message keys (toolCallId or role:timestamp) to the model ID (provider/modelId)
	 * active when the message was created. Survives `structuredClone(messages)` in Pi's `emitContext`.
	 */
	private messageKeyModelMap = new Map<string, string>();

	/** Currently active model ID */
	private currentActiveModelId: string | null = null;

	/** Character threshold for large tool outputs */
	private readonly threshold: number;

	constructor(threshold = 1200) {
		this.threshold = threshold;
	}

	/**
	 * Compute deterministic key for a message that survives structuredClone()
	 */
	public static getMessageKey(msg: any): string | null {
		if (!msg || typeof msg !== "object") return null;
		if ((msg.role === "toolResult" || msg.role === "tool") && typeof msg.toolCallId === "string") {
			return `tool:${msg.toolCallId}`;
		}
		if (typeof msg.role === "string" && typeof msg.timestamp === "number") {
			return `${msg.role}:${msg.timestamp}`;
		}
		return null;
	}

	/**
	 * Set or synchronize the active model ID
	 */
	public setActiveModel(modelId: string | null): void {
		this.currentActiveModelId = modelId;
	}

	/**
	 * Handle model_select lifecycle event
	 */
	public onModelSelect(event: ModelSelectEvent): void {
		if (event.model) {
			this.currentActiveModelId = `${event.model.provider}/${event.model.id}`;
		}
	}

	/**
	 * Reconstruct message-to-model attribution from sessionManager entries
	 */
	public syncFromSessionEntries(ctx: ExtensionContext): void {
		if (ctx.model) {
			this.currentActiveModelId = `${ctx.model.provider}/${ctx.model.id}`;
		}

		if (!ctx.sessionManager || typeof ctx.sessionManager.getEntries !== "function") {
			return;
		}

		const entries = ctx.sessionManager.getEntries();
		let runningModel = this.currentActiveModelId || "unknown";

		// Inspect session header
		try {
			const header = ctx.sessionManager.getHeader?.();
			if (header && (header as any).provider && (header as any).model) {
				runningModel = `${(header as any).provider}/${(header as any).model}`;
			}
		} catch {
			// Ignore header read errors
		}

		for (const entry of entries) {
			if (entry.type === "model_change") {
				const mc = entry as any;
				if (mc.provider && mc.modelId) {
					runningModel = `${mc.provider}/${mc.modelId}`;
				}
			} else if (entry.type === "message") {
				const me = entry as any;
				if (me.message) {
					if (me.message.role === "assistant" && me.message.provider && me.message.model) {
						runningModel = `${me.message.provider}/${me.message.model}`;
					}
					this.trackMessage(me.message, runningModel);
				}
			}
		}
	}

	/**
	 * Track that a message belongs to the current or specified active model
	 */
	public trackMessage(message: AgentMessage, modelId?: string): void {
		const targetModel = modelId || this.currentActiveModelId || "unknown";
		const key = ContextGuard.getMessageKey(message);
		if (key) {
			this.messageKeyModelMap.set(key, targetModel);
		}
	}

	/**
	 * Retrieve originating model ID for a message
	 */
	public getMessageModel(message: AgentMessage): string | undefined {
		if (message.role === "assistant" && (message as any).provider && (message as any).model) {
			return `${(message as any).provider}/${(message as any).model}`;
		}
		const key = ContextGuard.getMessageKey(message);
		if (key && this.messageKeyModelMap.has(key)) {
			return this.messageKeyModelMap.get(key);
		}
		return undefined;
	}

	/**
	 * Infer originating model ID for every message in the transcript sequence.
	 * Uses explicit tracking map first, and falls back to inline assistant message metadata (`provider/model`).
	 */
	private resolveMessageModels(messages: AgentMessage[], fallbackActiveModel: string): (string | undefined)[] {
		const resolved: (string | undefined)[] = new Array(messages.length);
		let runningModel: string | undefined;

		// Forward pass: track model from known keys or assistant messages
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]!;
			const explicit = this.getMessageModel(msg);
			if (explicit && explicit !== "unknown") {
				runningModel = explicit;
				resolved[i] = explicit;
			} else if (runningModel) {
				resolved[i] = runningModel;
			}
		}

		// Backward pass: attribute leading user/tool messages before the first assistant response
		// to that first assistant response's model
		let nextKnownModel: string | undefined = fallbackActiveModel;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (resolved[i]) {
				nextKnownModel = resolved[i];
			} else if (nextKnownModel) {
				resolved[i] = nextKnownModel;
			}
		}

		return resolved;
	}

	/**
	 * Context hook logic:
	 * - If no model switch occurred (all messages originate from current model), return null
	 *   to preserve 100% exact message list and maintain server-side KV Cache hits.
	 * - If a manual model switch is detected, construct an ephemeral view replacing large
	 *   historical tool outputs from prior models with concise placeholders.
	 */
	public protectContextOnModelSwitch(
		messages: AgentMessage[],
		currentModelId: string,
	): AgentMessage[] | null {
		if (!currentModelId || messages.length === 0) return null;

		const messageModels = this.resolveMessageModels(messages, currentModelId);
		const hasCrossModel = messageModels.some(
			(m) => m !== undefined && m !== "unknown" && m !== currentModelId,
		);

		if (!hasCrossModel) {
			// Zero changes: preserve identity to guarantee KV Cache hits
			return null;
		}

		let modified = false;
		const result: AgentMessage[] = [];

		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]!;
			const isToolMsg = msg.role === "toolResult" || (msg as any).role === "tool";
			if (!isToolMsg) {
				result.push(msg);
				continue;
			}

			// Check if this tool result was generated under a prior model
			const originModel = messageModels[i];
			const isFromOldModel = originModel && originModel !== "unknown" && originModel !== currentModelId;

			if (!isFromOldModel) {
				// Generated under current model; keep unmodified
				result.push(msg);
				continue;
			}

			// Prune bulky file content if length exceeds threshold
			const pruned = this.pruneToolMessageIfNeeded(msg, currentModelId);
			if (pruned !== msg) {
				modified = true;
				result.push(pruned);
			} else {
				result.push(msg);
			}
		}

		return modified ? result : null;
	}

	private pruneToolMessageIfNeeded(msg: any, targetModelId: string): any {
		const toolName = msg.toolName || "tool";
		let totalChars = 0;

		if (Array.isArray(msg.content)) {
			for (const c of msg.content) {
				if (c && typeof c.text === "string") {
					totalChars += c.text.length;
				}
			}
		} else if (typeof msg.content === "string") {
			totalChars = msg.content.length;
		}

		if (totalChars <= this.threshold) {
			return msg;
		}

		const placeholder = `[Omitted: Cached '${toolName}' output (${totalChars} chars) pruned across model switch to ${targetModelId}. Architecture summary is retained in system context.]`;

		return {
			...msg,
			content: [{ type: "text", text: placeholder }],
		};
	}
}
