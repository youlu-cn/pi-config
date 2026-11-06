import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface SessionTitleController {
	setTaskTitle(title: string): void;
	setWorking(working: boolean): void;
	setAnimationFrame(frame?: string): void;
	isWorking(): boolean;
	paint(): void;
}

/**
 * Keeps terminal-title rendering under one owner so UI metadata and animations compose.
 * Register it before title producers: its session_start reset must run before state restore.
 */
export function registerSessionTitleController(
	pi: ExtensionAPI,
): SessionTitleController {
	let activeContext: ExtensionContext | undefined;
	let taskTitle = "";
	let working = false;
	let animationFrame: string | undefined;

	const paint = (ctx = activeContext) => {
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		const directory = basename(ctx.cwd || process.cwd()) || "pi";
		const task = taskTitle || pi.getSessionName()?.trim() || directory;
		const prefix = animationFrame ? `${animationFrame} π` : working ? "● π" : "π";
		ctx.ui.setTitle(
			task === directory
				? `${prefix} · ${directory}`
				: `${prefix} · ${task} · ${directory}`,
		);
	};

	const controller: SessionTitleController = {
		setTaskTitle(title) {
			taskTitle = title.trim();
			paint();
		},
		setWorking(nextWorking) {
			working = nextWorking;
			paint();
		},
		setAnimationFrame(frame) {
			animationFrame = frame;
			paint();
		},
		isWorking() {
			return working;
		},
		paint,
	};

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		taskTitle = "";
		working = false;
		animationFrame = undefined;
		paint(ctx);
	});

	pi.on("session_info_changed", () => {
		paint();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		working = false;
		animationFrame = undefined;
		taskTitle = "";
		paint(ctx);
		activeContext = undefined;
	});

	return controller;
}
