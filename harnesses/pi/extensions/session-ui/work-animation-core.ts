export function renderGeminiDots(
	step: number,
	theme: { fg: (color: string, text: string) => string },
	total = 4,
): string {
	const count = Math.max(2, total);
	const cycle = (count - 1) * 2;
	const pos = Math.abs(step) % cycle;
	const activeIndex = pos < count ? pos : cycle - pos;

	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		if (i === activeIndex) {
			parts.push(theme.fg("accent", "●"));
		} else {
			parts.push(theme.fg("dim", "·"));
		}
	}
	return parts.join(" ");
}

export function phaseForTool(toolName: string): string {
	const name = toolName.toLowerCase();
	if (name === "read" || name.includes("fetch")) return "Reading...";
	if (name === "edit" || name === "write") return "Editing...";
	if (name === "bash") return "Running command...";
	if (name.includes("search") || name.includes("grep")) return "Searching...";
	if (name.includes("diagnostic") || name.includes("lsp")) {
		return "Checking code...";
	}
	if (name.includes("image")) return "Processing image...";
	const safeName =
		toolName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "tool";
	return `Using ${safeName}...`;
}
