import assert from "node:assert/strict";
import test from "node:test";
import { registerSessionTitleController } from "./title-controller.ts";

type Handler = (event: unknown, ctx: unknown) => void;

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const titles: string[] = [];
	let sessionName: string | undefined;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getSessionName() {
			return sessionName;
		},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/workspace/project",
		ui: {
			setTitle(title: string) {
				titles.push(title);
			},
		},
	};
	const dispatch = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	return {
		pi,
		ctx,
		titles,
		dispatch,
		setSessionName(name?: string) {
			sessionName = name;
		},
	};
}

test("title controller composes task, working state, and animation frames", () => {
	const harness = createHarness();
	const controller = registerSessionTitleController(harness.pi as never);

	harness.dispatch("session_start");
	assert.equal(harness.titles.at(-1), "π · project");

	controller.setTaskTitle("Current task");
	assert.equal(harness.titles.at(-1), "π · Current task · project");

	controller.setWorking(true);
	assert.equal(controller.isWorking(), true);
	assert.equal(harness.titles.at(-1), "● π · Current task · project");

	controller.setAnimationFrame("⠋");
	assert.equal(harness.titles.at(-1), "⠋ π · Current task · project");

	controller.setAnimationFrame(undefined);
	assert.equal(harness.titles.at(-1), "● π · Current task · project");
});

test("title controller falls back to session name and clears task on shutdown", () => {
	const harness = createHarness();
	const controller = registerSessionTitleController(harness.pi as never);

	harness.dispatch("session_start");
	harness.setSessionName("Session goal");
	controller.setTaskTitle("");
	harness.dispatch("session_info_changed");
	assert.equal(harness.titles.at(-1), "π · Session goal · project");

	controller.setTaskTitle("Transient task");
	harness.dispatch("session_shutdown");
	assert.equal(harness.titles.at(-1), "π · Session goal · project");
});

test("title controller does not paint outside the TUI", () => {
	const harness = createHarness();
	harness.ctx.mode = "rpc";
	const controller = registerSessionTitleController(harness.pi as never);

	harness.dispatch("session_start");
	controller.setTaskTitle("Hidden");
	controller.setWorking(true);
	assert.deepEqual(harness.titles, []);
});
