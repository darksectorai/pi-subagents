import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSlashStatusText, pickLiveProgressEntry } from "../../slash-progress.ts";
import type { Details } from "../../types.ts";

describe("slash progress helpers", () => {
	it("prefers running progress over earlier completed progress", () => {
		const progress: NonNullable<Details["progress"]> = [
			{
				index: 0,
				agent: "scout",
				status: "completed",
				task: "step 1",
				recentTools: [],
				recentOutput: [],
				toolCount: 1,
				tokens: 10,
				durationMs: 100,
			},
			{
				index: 1,
				agent: "reviewer",
				status: "running",
				task: "step 2",
				currentTool: "bash",
				recentTools: [],
				recentOutput: [],
				toolCount: 4,
				tokens: 20,
				durationMs: 200,
			},
		];

		assert.equal(pickLiveProgressEntry(progress)?.agent, "reviewer");
		assert.equal(formatSlashStatusText(progress), "4 tools bash | Ctrl+O live detail");
	});

	it("falls back to default running text when no progress exists", () => {
		assert.equal(pickLiveProgressEntry(undefined), undefined);
		assert.equal(formatSlashStatusText(undefined), "running... | Ctrl+O live detail");
	});
});
