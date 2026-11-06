import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderAdapter } from "./types.ts";
import { AntigravityAdapter } from "./adapters/antigravity.ts";
import { GptAdapter } from "./adapters/gpt.ts";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { GrokAdapter } from "./adapters/grok.ts";

export class AdapterRegistry {
	private readonly adapters: Map<string, ProviderAdapter> = new Map();

	constructor() {
		// 注册默认内置 Adapters
		this.register(new AntigravityAdapter());
		this.register(new GptAdapter());
		this.register(new ClaudeAdapter());
		this.register(new GrokAdapter());
	}

	register(adapter: ProviderAdapter): void {
		this.adapters.set(adapter.id, adapter);
	}

	get(id: string): ProviderAdapter | undefined {
		return this.adapters.get(id);
	}

	list(): ProviderAdapter[] {
		return Array.from(this.adapters.values());
	}

	/** Find adapter matching the given provider ID (e.g. "openai-codex" -> GptAdapter) */
	findAdapterForProvider(providerId: string): ProviderAdapter | undefined {
		for (const adapter of this.adapters.values()) {
			if (adapter.supportedProviders.includes(providerId)) {
				return adapter;
			}
		}
		return undefined;
	}

	/** Find all adapters that have valid configuration in the current environment */
	getAllConfigured(ctx: ExtensionContext): ProviderAdapter[] {
		return this.list().filter((adapter) => adapter.isConfigured(ctx));
	}
}
