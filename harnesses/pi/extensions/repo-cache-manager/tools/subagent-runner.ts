import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ExecSubagentResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface IsolatedAgentOptions {
	name: string;
	provider: string;
	model: string;
	tools: string;
	cwd: string;
	prompt: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Check whether tmux is installed and usable in the environment.
 */
export function hasTmux(): boolean {
	try {
		const res = spawnSync("tmux", ["-V"], { stdio: "ignore" });
		return res.status === 0;
	} catch {
		return false;
	}
}

/**
 * Resolve the absolute executable path for subagent CLI.
 */
export function resolveSubagentCommand(): string {
	const candidates = [
		join(homedir(), ".pi", "agent", "bin", "subagent"),
		join(homedir(), ".pi", "agent", "git", "github.com", "badlogic", "pi-subagent", "subagent.ts"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return "subagent";
}

/**
 * Extract the 6-char hex handle from `subagent spawn` output.
 * Output format:
 *   Spawned scout (a1b2c3)
 *   State: busy
 *   Attach: tmux attach -t pi-subagent-a1b2c3
 */
export function parseSubagentHandle(output: string): string | null {
	const parenMatch = /\(([a-f0-9]{6,12})\)/i.exec(output);
	if (parenMatch?.[1]) return parenMatch[1];

	const tmuxMatch = /pi-subagent-([a-f0-9]{6,12})/i.exec(output);
	if (tmuxMatch?.[1]) return tmuxMatch[1];

	return null;
}

/**
 * Run an arbitrary command asynchronously with timeout, signal, and augmented PATH.
 */
export function execCommandAsync(
	cmd: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecSubagentResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted by user"));
			return;
		}

		const agentBin = join(homedir(), ".pi", "agent", "bin");
		const currentPath = process.env.PATH || "";
		const augmentedPath = currentPath.includes(agentBin)
			? currentPath
			: `${agentBin}:/opt/homebrew/bin:/usr/local/bin:${currentPath}`;

		const child = spawn(cmd, args, {
			cwd: options.cwd || process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: augmentedPath,
			},
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (options.signal) {
				options.signal.removeEventListener("abort", onAbort);
			}
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				child.kill("SIGTERM");
			} catch {}
			reject(new Error("Operation aborted by user"));
		};

		if (options.signal) {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}

		if (options.timeoutMs && options.timeoutMs > 0) {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				try {
					child.kill("SIGTERM");
				} catch {}
				reject(new Error(`Command ${cmd} timed out after ${options.timeoutMs}ms`));
			}, options.timeoutMs);
		}

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		});

		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
			});
		});
	});
}

/**
 * Execute an isolated subagent run.
 * Prefers `subagent` CLI (if tmux is available); seamlessly falls back to
 * standalone non-interactive `pi --print` (which provides full subagent physical isolation
 * without requiring tmux).
 */
export async function runIsolatedSubagent(options: IsolatedAgentOptions): Promise<string> {
	// 1. If tmux is available, attempt subagent CLI
	if (hasTmux()) {
		let subagentHandle: string | null = null;
		try {
			const subagentCmd = resolveSubagentCommand();
			const spawnArgs = [
				"spawn",
				"--name",
				options.name,
				"--provider",
				options.provider,
				"--model",
				options.model,
				"--tools",
				options.tools,
				"--no-skills",
				"--no-prompt-templates",
				"--cwd",
				options.cwd,
				"--prompt",
				options.prompt,
			];

			const spawnRes = await execCommandAsync(subagentCmd, spawnArgs, {
				cwd: options.cwd,
				timeoutMs: 10000,
				signal: options.signal,
			});

			if (spawnRes.exitCode === 0) {
				subagentHandle = parseSubagentHandle(spawnRes.stdout);
				if (subagentHandle) {
					const waitRes = await execCommandAsync(
						subagentCmd,
						["wait", subagentHandle, "--timeout", String(Math.floor((options.timeoutMs || 120000) / 1000))],
						{
							cwd: options.cwd,
							timeoutMs: options.timeoutMs || 125000,
							signal: options.signal,
						},
					);
					if (waitRes.exitCode === 0 && waitRes.stdout.trim().length > 0) {
						return waitRes.stdout;
					}
				}
			}
		} catch {
			// Subagent CLI execution failed; proceed to headless pi --print fallback
		} finally {
			if (subagentHandle) {
				try {
					const subagentCmd = resolveSubagentCommand();
					await execCommandAsync(subagentCmd, ["stop", subagentHandle], { timeoutMs: 5000 });
				} catch {}
			}
		}
	}

	// 2. Direct isolated subagent process via headless `pi --print`
	// Physically isolated in a separate child process with scoped tools and no skills/prompt-templates
	const piArgs = [
		"--provider",
		options.provider,
		"--model",
		options.model,
		"--tools",
		options.tools,
		"--no-skills",
		"--no-prompt-templates",
		"--print",
		options.prompt,
	];

	const piRes = await execCommandAsync("pi", piArgs, {
		cwd: options.cwd,
		timeoutMs: options.timeoutMs || 120000,
		signal: options.signal,
	});

	if (piRes.exitCode !== 0 && !piRes.stdout) {
		throw new Error(piRes.stderr || `pi process exited with code ${piRes.exitCode}`);
	}

	return piRes.stdout;
}
