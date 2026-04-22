import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentConfig } from "../../agents.ts";
import {
	compileQualityGate,
	readValidatorArtifact,
	resolveQualityGateOutputPath,
	resolveValidatorSchemaPath,
	summarizeValidatorArtifact,
	type ValidateFunction,
} from "../../quality-gate.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(prefix = "pi-quality-gate-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: name,
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/tmp/${name}.md`,
		...overrides,
	};
}

describe("quality gate helpers", () => {
	it("resolves validation output path templates relative to cwd", () => {
		const cwd = path.join(os.tmpdir(), "repo");
		const resolved = resolveQualityGateOutputPath(
			".pi-quality/{run_id}-{agent}-{attempt}-{phase}.json",
			cwd,
			{ runId: "run-1", agent: "producer", attempt: 2, phase: "validator" },
		);

		assert.equal(
			resolved,
			path.join(cwd, ".pi-quality", "run-1-producer-2-validator.json"),
		);
	});

	it("resolves validator schemas using the configured search priority", () => {
		const root = tempDir();
		const project = path.join(root, "project-schemas");
		const user = path.join(root, "user-schemas");
		const builtin = path.join(root, "builtin-schemas");
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(user, { recursive: true });
		fs.mkdirSync(builtin, { recursive: true });
		fs.writeFileSync(path.join(user, "result.schema.json"), "{}", "utf-8");
		fs.writeFileSync(path.join(project, "result.schema.json"), "{}", "utf-8");
		fs.writeFileSync(path.join(builtin, "other.schema.json"), "{}", "utf-8");

		const config = agent("producer", { schemaSearchDirs: [project, user, builtin] });

		assert.equal(resolveValidatorSchemaPath(config, "result.schema.json"), path.join(project, "result.schema.json"));
		assert.equal(resolveValidatorSchemaPath(config, "other.schema.json"), path.join(builtin, "other.schema.json"));
		assert.equal(resolveValidatorSchemaPath(config, "missing.schema.json"), undefined);
	});

	it("compiles quality gate config and applies maxRetries override", () => {
		const cwd = tempDir();
		const producer = agent("producer", {
			qualityGate: {
				validator: "validator",
				fixer: "fixer",
				validationOutput: "validation.json",
				passField: "pass",
				maxRetries: 1,
				enabledByDefault: true,
				onExhausted: "stop",
			},
		});

		const compiled = compileQualityGate({
			agent: producer,
			agents: [producer, agent("validator"), agent("fixer")],
			cwd,
			runId: "run-1",
			maxRetriesOverride: 3,
		});

		assert.equal(compiled.config.maxRetries, 3);
		assert.equal(compiled.validationOutputPath, path.join(cwd, "validation.json"));
	});

	it("rejects misconfigured quality gate references early", () => {
		const cwd = tempDir();
		const producer = agent("producer", {
			qualityGate: {
				validator: "validator",
				fixer: "missing-fixer",
				validationOutput: "validation.json",
				passField: "pass",
				maxRetries: 1,
				enabledByDefault: true,
				onExhausted: "stop",
			},
		});

		assert.throws(
			() => compileQualityGate({ agent: producer, agents: [producer, agent("validator")], cwd }),
			/qualityGate\.fixer references unknown agent 'missing-fixer'/,
		);

		assert.throws(
			() => compileQualityGate({
				agent: { ...producer, qualityGate: { ...producer.qualityGate!, maxRetries: -1 } },
				agents: [producer, agent("validator"), agent("missing-fixer")],
				cwd,
			}),
			/qualityGate\.maxRetries must be an integer >= 0/,
		);
	});

	it("reads validator artifacts and enforces boolean pass fields", () => {
		const dir = tempDir();
		const artifactPath = path.join(dir, "validation.json");
		fs.writeFileSync(artifactPath, JSON.stringify({ pass: false, issues: ["missing title"] }), "utf-8");

		const artifact = readValidatorArtifact(artifactPath, "pass");

		assert.equal(artifact.pass, false);
		assert.deepEqual(artifact.value.issues, ["missing title"]);

		fs.writeFileSync(artifactPath, JSON.stringify({ pass: "yes" }), "utf-8");
		assert.throws(() => readValidatorArtifact(artifactPath, "pass"), /must contain boolean field 'pass'/);

		fs.writeFileSync(artifactPath, "not json", "utf-8");
		assert.throws(() => readValidatorArtifact(artifactPath, "pass"), /is not valid JSON/);
	});

	it("surfaces schema validation errors from validator artifacts", () => {
		const dir = tempDir();
		const artifactPath = path.join(dir, "validation.json");
		fs.writeFileSync(artifactPath, JSON.stringify({ pass: true }), "utf-8");
		const validateSchema = (() => false) as ValidateFunction;
		validateSchema.errors = [{ instancePath: "/issues", message: "must be array" }];

		assert.throws(
			() => readValidatorArtifact(artifactPath, "pass", validateSchema),
			/failed validatorOutputSchema validation: \/issues must be array/,
		);
	});

	it("truncates long validator artifacts for retry/fixer prompts", () => {
		assert.equal(summarizeValidatorArtifact("  ok  ", 10), "ok");
		assert.equal(summarizeValidatorArtifact("abcdef", 3), "abc\n...");
	});
});
