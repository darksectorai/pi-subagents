import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type { AgentConfig } from "./agents.ts";
import type { QualityGateConfig } from "./types.ts";

const require = createRequire(import.meta.url);

export type ValidateFunction = ((value: unknown) => boolean) & {
	errors?: Array<{ instancePath?: string; message?: string }> | null;
};

export interface CompiledQualityGate {
	config: QualityGateConfig;
	validationOutputPath: string;
	schemaPath?: string;
	validateSchema?: ValidateFunction;
}

export interface ValidatorArtifact {
	value: Record<string, unknown>;
	pass: boolean;
	raw: string;
}

export function resolveQualityGateOutputPath(
	rawPath: string,
	cwd: string,
	meta: { runId?: string; agent: string; attempt: number; phase: string },
): string {
	const templated = rawPath
		.replace(/\{cwd\}/g, cwd)
		.replace(/\{run_id\}/g, meta.runId ?? "")
		.replace(/\{agent\}/g, meta.agent)
		.replace(/\{attempt\}/g, String(meta.attempt))
		.replace(/\{phase\}/g, meta.phase);
	return path.isAbsolute(templated) ? templated : path.join(cwd, templated);
}

export function resolveValidatorSchemaPath(agent: AgentConfig, schemaName: string | undefined): string | undefined {
	if (!schemaName) return undefined;
	if (path.isAbsolute(schemaName)) return fs.existsSync(schemaName) ? schemaName : undefined;
	const searchDirs = agent.schemaSearchDirs && agent.schemaSearchDirs.length > 0
		? agent.schemaSearchDirs
		: [path.join(path.dirname(path.dirname(agent.filePath)), "schemas")];
	for (const dir of searchDirs) {
		const candidate = path.join(dir, schemaName);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function loadValidatorSchema(schemaPath: string): ValidateFunction {
	let raw: string;
	try {
		raw = fs.readFileSync(schemaPath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read validatorOutputSchema '${schemaPath}': ${message}`, { cause: error });
	}

	let schema: unknown;
	try {
		schema = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse validatorOutputSchema '${schemaPath}' as JSON: ${message}`, { cause: error });
	}

	try {
		const ajvModule = require("ajv") as { default?: new (options: object) => { compile(schema: unknown): ValidateFunction } } | (new (options: object) => { compile(schema: unknown): ValidateFunction });
		const Ajv = typeof ajvModule === "function" ? ajvModule : ajvModule.default;
		if (!Ajv) throw new Error("Ajv export not found");
		return new Ajv({ allErrors: true, strict: false }).compile(schema);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to compile validatorOutputSchema '${schemaPath}': ${message}`, { cause: error });
	}
}

export function compileQualityGate(input: {
	agent: AgentConfig;
	agents: AgentConfig[];
	cwd: string;
	runId?: string;
	maxRetriesOverride?: number;
}): CompiledQualityGate {
	const gate = input.agent.qualityGate;
	if (!gate) throw new Error(`Agent '${input.agent.name}' has no qualityGate.`);
	if (!gate.validator) throw new Error(`Agent '${input.agent.name}' qualityGate.validator is required.`);
	if (!input.agents.some((agent) => agent.name === gate.validator)) {
		throw new Error(`Agent '${input.agent.name}' qualityGate.validator references unknown agent '${gate.validator}'.`);
	}
	if (!gate.validationOutput) throw new Error(`Agent '${input.agent.name}' qualityGate.validationOutput is required.`);
	if (gate.validator === input.agent.name) {
		throw new Error(`Agent '${input.agent.name}' qualityGate.validator cannot reference itself.`);
	}
	if (gate.fixer) {
		if (!input.agents.some((agent) => agent.name === gate.fixer)) {
			throw new Error(`Agent '${input.agent.name}' qualityGate.fixer references unknown agent '${gate.fixer}'.`);
		}
		if (gate.fixer === input.agent.name) {
			throw new Error(`Agent '${input.agent.name}' qualityGate.fixer cannot reference itself.`);
		}
	}

	const maxRetries = input.maxRetriesOverride ?? gate.maxRetries;
	if (!Number.isInteger(maxRetries) || maxRetries < 0) {
		throw new Error(`Agent '${input.agent.name}' qualityGate.maxRetries must be an integer >= 0.`);
	}
	if (!gate.passField.trim()) {
		throw new Error(`Agent '${input.agent.name}' qualityGate.passField must be non-empty.`);
	}

	const validationOutputPath = resolveQualityGateOutputPath(gate.validationOutput, input.cwd, {
		runId: input.runId,
		agent: input.agent.name,
		attempt: 1,
		phase: "validator",
	});
	const schemaPath = resolveValidatorSchemaPath(input.agent, gate.validatorOutputSchema);
	if (gate.validatorOutputSchema && !schemaPath) {
		const dirs = input.agent.schemaSearchDirs?.join(", ") || "(none)";
		throw new Error(`Agent '${input.agent.name}' qualityGate.validatorOutputSchema '${gate.validatorOutputSchema}' was not found in schema search path: ${dirs}.`);
	}

	return {
		config: { ...gate, maxRetries },
		validationOutputPath,
		schemaPath,
		validateSchema: schemaPath ? loadValidatorSchema(schemaPath) : undefined,
	};
}

export function readValidatorArtifact(
	filePath: string,
	passField: string,
	validateSchema?: ValidateFunction,
): ValidatorArtifact {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Validator artifact not found: ${filePath}`);
	}
	const raw = fs.readFileSync(filePath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Validator artifact '${filePath}' is not valid JSON: ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Validator artifact '${filePath}' must contain a JSON object.`);
	}
	const value = parsed as Record<string, unknown>;
	if (validateSchema && !validateSchema(value)) {
		const errors = validateSchema.errors?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
		throw new Error(`Validator artifact '${filePath}' failed validatorOutputSchema validation: ${errors || "invalid"}`);
	}
	if (typeof value[passField] !== "boolean") {
		throw new Error(`Validator artifact '${filePath}' must contain boolean field '${passField}'.`);
	}
	return { value, pass: value[passField], raw };
}

export function summarizeValidatorArtifact(raw: string, maxLength = 4000): string {
	const trimmed = raw.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength)}\n...`;
}
