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
		const disabledExt = join(target, "extensions/repo-cache-manager");
		const disabledConfig = join(target, "repo-cache-manager.json");
		assert.ok(!existsSync(disabledExt));
		assert.ok(!existsSync(disabledConfig));

		// Simulate an installation made before the extension was disabled.
		const sourceExt = join(harness, "extensions/repo-cache-manager");
		if (force) {
			write(join(disabledExt, "index.ts"), "// Previously installed copy\n");
		} else {
			symlinkSync(sourceExt, disabledExt);
		}
		write(disabledConfig, '{"custom":true}\n');
		const copyArgs = ["--mode", "copy", ...(force ? ["--force"] : [])];
		assert.match(run(...copyArgs, "--dry-run"), /\[DISABLE\].*repo-cache-manager/);
		assert.ok(existsSync(disabledExt));
		assert.ok(!readdirSync(target).some((name) => name.startsWith("disabled-")));

		run(...copyArgs);
		assert.ok(!existsSync(disabledExt));
		assert.equal(readFileSync(disabledConfig, "utf8"), '{"custom":true}\n');
		const backups = readdirSync(target).filter((name) => name.startsWith("disabled-repo-cache-manager."));
		assert.equal(backups.length, 1);
		const archivedExt = join(target, backups[0], "repo-cache-manager");
		if (force) {
			assert.equal(readFileSync(join(archivedExt, "index.ts"), "utf8"), "// Previously installed copy\n");
		} else {
			assert.equal(readlinkSync(archivedExt), sourceExt);
		}
		assert.equal(lstatSync(join(target, "settings.json")).isSymbolicLink(), false);
		const sourceSessionUi = join(harness, "extensions/session-ui");
		const targetSessionUi = join(target, "extensions/session-ui");
		assert.equal(lstatSync(targetSessionUi).isSymbolicLink(), false);
		assert.equal(lstatSync(join(targetSessionUi, "config.json")).isSymbolicLink(), false);
		assert.equal(readFileSync(join(targetSessionUi, "config.json"), "utf8"), '{"enabled":true}\n');
		assert.equal(readlinkSync(join(sourceSessionUi, "config.json")), "../../plugin-configs/session-ui/config.json");
		assert.deepEqual(readdirSync(sourceSessionUi).sort(), ["config.json", "index.ts"]);
		writeFileSync(join(targetSessionUi, "config.json"), '{"enabled":false}\n');
		assert.equal(readFileSync(join(sourceSessionUi, "config.json"), "utf8"), '{"enabled":true}\n');
		assert.equal(lstatSync(join(target, "extensions/fast")).isSymbolicLink(), false);
		assert.equal(lstatSync(join(target, "fast.json")).isSymbolicLink(), false);
		assert.equal(readFileSync(join(target, "fast.json"), "utf8"), '{"enabled":false}\n');
	});
}
