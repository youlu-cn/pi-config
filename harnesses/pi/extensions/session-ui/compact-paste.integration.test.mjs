import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

// Run explicitly against an installed Pi, without installing project dependencies.
const root = process.env.PI_PACKAGE_ROOT;
test("native text paste and image labels against installed Pi", { skip: !root }, async () => {
	const require = createRequire(resolve(root, "package.json"));
	const { createJiti } = require("jiti");
	const corePath = resolve(root, "dist/index.js");
	const tuiPath = require.resolve("@earendil-works/pi-tui");
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		fsCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": corePath,
			"@earendil-works/pi-tui": tuiPath,
		},
	});
	const { CompactPasteEditor } = await jiti.import(fileURLToPath(new URL("./compact-paste.ts", import.meta.url)));
	const { CustomEditor } = await import(pathToFileURL(corePath).href);
	const { visibleWidth } = await import(pathToFileURL(tuiPath).href);
	const theme = { borderColor: (text) => text, selectList: {} };
	const keys = { matches: () => false, getKeys: () => [] };
	for (const mode of ["regular", "fullscreen"]) {
		const tui = { mode, terminal: { rows: 40, columns: 80 }, requestRender() {} };
		for (const text of ["x".repeat(1000), "x".repeat(1200), "x".repeat(2000), Array(12).fill("abc").join("\n")]) {
			const native = new CustomEditor(tui, theme, keys);
			const custom = new CompactPasteEditor(tui, theme, keys);
			for (const editor of [native, custom]) {
				editor.setText("prefix");
				editor.handleInput(`\x1b[200~${text}\x1b[201~`);
				editor.handleInput("suffix");
			}
			assert.equal(custom.getText(), native.getText());
			assert.equal(custom.getExpandedText(), `prefix${text}suffix`);
			assert.deepEqual(custom.getCursor(), native.getCursor());
			for (const width of [8, 20, 40, 80]) {
				assert.deepEqual(custom.render(width), native.render(width));
			}
		}
		const editor = new CompactPasteEditor(tui, theme, keys);
		editor.setText("prefix");
		const path1 = "/tmp/pi-clipboard-dead-beef.png";
		const path2 = "/tmp/pi-clipboard-abcd.png";
		editor.insertTextAtCursor(path1);
		assert.equal(editor.getText(), "prefix[paste #1]");
		assert.equal(editor.getExpandedText(), `prefix${path1}`);
		editor.insertTextAtCursor(path2);
		assert.equal(editor.getText(), "prefix[paste #1][paste #2]");
		editor.handleInput("suffix");
		assert.equal(editor.getExpandedText(), `prefix${path1}${path2}suffix`);
		assert.match(editor.render(80).join("\n"), /\[image #1\]\[image #2\]/);
		for (const width of [8, 20, 40, 80]) {
			const original = CustomEditor.prototype.render.call(editor, width);
			assert.deepEqual(editor.render(width).map(visibleWidth), original.map(visibleWidth));
		}
		// Image numbering stays independent of text paste IDs, preserving columns.
		const mixed = new CompactPasteEditor(tui, theme, keys);
		for (let i = 0; i < 11; i++) mixed.handleInput(`\x1b[200~${"x".repeat(1200)}\x1b[201~`);
		mixed.insertTextAtCursor(path1);
		assert.match(mixed.render(80).join("\n"), /\[image #1\]/);
		assert.deepEqual(mixed.render(80).map(visibleWidth), CustomEditor.prototype.render.call(mixed, 80).map(visibleWidth));
	}
});
