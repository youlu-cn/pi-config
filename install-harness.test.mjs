import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./install-harness.sh", import.meta.url));

for (const force of [false, true]) {
	test(`symlink to copy isolates deployed files without changing source (force=${force})`, (t) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-install-test-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const source = join(dir, "source");
		const harness = join(source, "harnesses/pi");
		const target = join(dir, "agent");
		mkdirSync(source);
		copyFileSync(script, join(source, "install-harness.sh"));
		const write = (path, content) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};
		write(join(harness, "config/settings.json"), '{"packages":[]}\n');
		for (const name of ["session-ui", "repo-cache-manager"]) {
			write(join(harness, `extensions/${name}/index.ts`), "export default function () {}\n");
			write(join(harness, `plugin-configs/${name}/config.json`), '{"enabled":true}\n');
			symlinkSync(`../../plugin-configs/${name}/config.json`, join(harness, `extensions/${name}/config.json`));
		}
		write(join(harness, "extensions/fast/index.ts"), "export default function () {}\n");
		write(join(harness, "plugin-configs/fast/config.json"), '{"enabled":false}\n');
		const run = (...args) => execFileSync("bash", [join(source, "install-harness.sh"), "--target", target, ...args], { encoding: "utf8" });
		run();
		assert.ok(lstatSync(join(target, "settings.json")).isSymbolicLink());
		assert.ok(lstatSync(join(target, "extensions/fast")).isSymbolicLink());
		assert.equal(readFileSync(join(target, "fast.json"), "utf8"), '{"enabled":false}\n');
		run("--mode", "copy", ...(force ? ["--force"] : []));
		assert.equal(lstatSync(join(target, "settings.json")).isSymbolicLink(), false);
		for (const name of ["session-ui", "repo-cache-manager"]) {
			const sourceExt = join(harness, "extensions", name);
			const targetExt = join(target, "extensions", name);
			assert.equal(lstatSync(targetExt).isSymbolicLink(), false);
			assert.equal(lstatSync(join(targetExt, "config.json")).isSymbolicLink(), false);
			assert.equal(readFileSync(join(targetExt, "config.json"), "utf8"), '{"enabled":true}\n');
			assert.equal(readlinkSync(join(sourceExt, "config.json")), `../../plugin-configs/${name}/config.json`);
			assert.deepEqual(readdirSync(sourceExt).sort(), ["config.json", "index.ts"]);
			writeFileSync(join(targetExt, "config.json"), '{"enabled":false}\n');
			assert.equal(readFileSync(join(sourceExt, "config.json"), "utf8"), '{"enabled":true}\n');
		}
		assert.ok(existsSync(join(target, "repo-cache-manager.json")));
		assert.equal(lstatSync(join(target, "extensions/fast")).isSymbolicLink(), false);
		assert.equal(lstatSync(join(target, "fast.json")).isSymbolicLink(), false);
		assert.equal(readFileSync(join(target, "fast.json"), "utf8"), '{"enabled":false}\n');
	});
}
