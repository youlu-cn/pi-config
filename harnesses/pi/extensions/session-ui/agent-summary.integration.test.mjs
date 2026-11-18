import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.env.PI_PACKAGE_ROOT;
test("agent summary truncates by terminal columns without splitting ANSI colors", { skip: !root }, async () => {
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	const { visibleWidth } = await import(pathToFileURL(tuiPath).href);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false, fsCache: false,
		alias: { "@earendil-works/pi-tui": tuiPath },
	});
	const { registerAgentSummary } = await jiti.import(fileURLToPath(new URL("./agent-summary.ts", import.meta.url)));
	let renderEntry;
	registerAgentSummary({ registerEntryRenderer: (_type, renderer) => { renderEntry = renderer; }, on() {} });

	const rgb = { mdQuoteBorder: "120;120;120", mdQuote: "200;200;200", success: "80;180;100", error: "145;100;100" };
	const color = (name) => `\x1b[38;2;${rgb[name]}m`;
	const theme = {
		fg: (name, value) => `${color(name)}${value}\x1b[39m`,
		italic: (value) => `\x1b[3m${value}\x1b[23m`,
		getFgAnsi: color,
	};
	const data = { commands: 9, reads: 6, edits: 1, writes: 0, others: 7, failed: 2, durationMs: 297633 };
	const component = renderEntry({ data }, {}, theme);
	// Strip only complete SGR sequences so a fragment left by a bad cut stays visible.
	const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");
	const expected = " │ Ran 9 commands, read 6 files, edited 1 file, 7 other tools, 2 failed · 4m 57s";
	const [wide] = component.render(300);
	assert.equal(plain(wide), expected);
	assert.ok(wide.includes(`${color("error")}2\x1b[0m`));

	const fullWidth = visibleWidth(expected);
	assert.equal(component.render(fullWidth)[0], wide);
	for (let width = 1; width < fullWidth; width++) {
		const [line] = component.render(width);
		assert.equal(plain(line), `${expected.slice(0, width - 1)}…`, `width ${width}`);
		assert.equal(visibleWidth(line), width);
	}
});
