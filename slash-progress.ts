import type { Details } from "./types.ts";

export function pickLiveProgressEntry(progress: Details["progress"]): NonNullable<Details["progress"]>[number] | undefined {
	if (!progress || progress.length === 0) return undefined;
	return progress.find((entry) => entry.status === "running")
		?? progress.find((entry) => !!entry.currentTool)
		?? progress[progress.length - 1];
}

export function formatSlashStatusText(progress: Details["progress"]): string {
	const current = pickLiveProgressEntry(progress);
	if (!current) return "running... | Ctrl+O live detail";
	const tool = current.currentTool ? ` ${current.currentTool}` : "";
	const count = current.toolCount ?? 0;
	return `${count} tools${tool} | Ctrl+O live detail`;
}
