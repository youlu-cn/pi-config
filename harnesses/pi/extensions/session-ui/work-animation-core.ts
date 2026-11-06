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
