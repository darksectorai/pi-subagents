/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ModelAttempt,
	type ProgressSummary,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "./skills.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { createJsonlWriter } from "./jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "./post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "./pi-args.ts";
import { captureSingleOutputSnapshot, resolveSingleOutput, type SingleOutputSnapshot } from "./single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "./model-fallback.ts";
import {
	compileQualityGate,
	readValidatorArtifact,
	resolveQualityGateOutputPath,
	summarizeValidatorArtifact,
} from "./quality-gate.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
	};
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
	},
): Promise<SingleResult> {
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		systemPrompt: shared.systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		promptFileStem: agent.name,
	});

	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: Date.now(),
	};
	result.progress = progress;

	const startTime = Date.now();
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		let intercomStarted = false;
		let removeAbortListener: (() => void) | undefined;

		const detachForIntercom = () => {
			detached = true;
			processClosed = true;
			result.detached = true;
			result.detachedReason = "intercom coordination";
			progress.status = "detached";
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = {
				toolCount: progress.toolCount,
				tokens: progress.tokens,
				durationMs: progress.durationMs,
			};
			finish(-2);
		};

		// If the child emits its final assistant message but never exits,
		// start a bounded drain window and force termination if needed.
		const FINAL_DRAIN_MS = 5000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed || detached) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				result.error = result.error
					?? `Subagent process did not exit within ${FINAL_DRAIN_MS}ms after its final message. Forcing termination.`;
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed || detached) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_DRAIN_MS);
			finalDrainTimer.unref?.();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			const accepted = intercomStarted;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted });
			if (!accepted) return;
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			resolve(code);
		};

		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			options.onUpdate({
				content: [{ type: "text", text }],
				details: { mode: "single", results: [resultSnapshot], progress: [progressSnapshot] },
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			emitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;

			if (evt.type === "tool_execution_start") {
				if (options.allowIntercomDetach && evt.toolName === "intercom") {
					intercomStarted = true;
				}
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
				progress.currentToolStartedAt = now;
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (!result.model && evt.message.model) result.model = evt.message.model;
					if (evt.message.errorMessage) result.error = evt.message.errorMessage;
					appendRecentOutput(progress, extractTextFromContent(evt.message.content).split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					if (stopReason === "stop" && !hasToolCall) {
						startFinalDrain();
					}
				}
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages.push(evt.message);
				appendRecentOutput(progress, extractTextFromContent(evt.message.content).split("\n").slice(-10));
				fireUpdate();
			}
		};

		let stderrBuf = "";

		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			childExited = true;
			clearFinalDrainTimers();
		});
		proc.on("close", (code, signal) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (detached) {
				finish(-2);
				return;
			}
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			const finalCode = forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			finish(finalCode);
		});
		proc.on("error", (error) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || detached) return;
				if (options.allowIntercomDetach && intercomStarted && !detached) {
					detachForIntercom();
					return;
				}
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}
	});
	result.exitCode = exitCode;
	if (result.detached) {
		result.exitCode = 0;
		result.finalOutput = "Detached for intercom coordination.";
		return result;
	}

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	let fullOutput = getFinalOutput(result.messages);
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
	}
	result.finalOutput = fullOutput;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: { mode: "single", results: [resultSnapshot], progress: [progressSnapshot] },
		});
	}
	return result;
}

/**
 * Run one subagent without applying qualityGate policy.
 */
async function runPlainSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}

	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const result = await runSingleAttempt(runtimeCwd, agent, task, candidate, options, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
		});
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attempt: ModelAttempt = {
			model: candidate ?? result.model ?? agent.model ?? "default",
			success: result.exitCode === 0,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (result.exitCode === 0) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (shareEnabled) {
		const sessionFile = options.sessionFile
			?? (options.sessionDir ? findLatestSessionFile(options.sessionDir) : null);
		if (sessionFile) {
			result.sessionFile = sessionFile;
		}
	}

	return result;
}

function mergeUsage(results: SingleResult[]): Usage {
	const usage = emptyUsage();
	for (const result of results) sumUsage(usage, result.usage);
	return usage;
}

function mergeProgressSummary(results: SingleResult[]): ProgressSummary {
	const usage = mergeUsage(results);
	return {
		toolCount: results.reduce((sum, result) => sum + (result.progressSummary?.toolCount ?? 0), 0),
		tokens: usage.input + usage.output,
		durationMs: results.reduce((sum, result) => sum + (result.progressSummary?.durationMs ?? 0), 0),
	};
}

function refreshOutputFromFile(result: SingleResult, outputPath: string | undefined): void {
	if (!outputPath) return;
	try {
		if (!fs.existsSync(outputPath)) return;
		result.finalOutput = fs.readFileSync(outputPath, "utf-8");
		result.savedOutputPath = outputPath;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		result.outputSaveError = message;
	}
}

function buildValidatorTask(input: {
	agentName: string;
	originalTask: string;
	producerOutput: string;
	validationOutputPath: string;
	passField: string;
	schemaPath?: string;
	outputPath?: string;
}): string {
	return [
		`Validate the output from agent '${input.agentName}'.`,
		"",
		"Original task:",
		input.originalTask,
		"",
		"Producer output:",
		input.producerOutput || "(no textual output)",
		input.outputPath ? `Primary output file: ${input.outputPath}` : undefined,
		"",
		`Write a JSON object to: ${input.validationOutputPath}`,
		`The JSON object must contain boolean field '${input.passField}'.`,
		input.schemaPath ? `It must also conform to JSON Schema: ${input.schemaPath}` : undefined,
		"Do not write markdown fences around the JSON artifact.",
	].filter((line): line is string => line !== undefined).join("\n");
}

function buildFixerTask(input: {
	agentName: string;
	originalTask: string;
	producerOutput: string;
	validationOutputPath: string;
	validationArtifact: string;
	outputPath?: string;
}): string {
	return [
		`Fix the output from agent '${input.agentName}' so it passes validation.`,
		"",
		"Original task:",
		input.originalTask,
		"",
		"Current output:",
		input.producerOutput || "(no textual output)",
		"",
		`Validator artifact: ${input.validationOutputPath}`,
		input.validationArtifact || "(empty validator artifact)",
		input.outputPath ? `Update the primary output file in place: ${input.outputPath}` : undefined,
	].filter((line): line is string => line !== undefined).join("\n");
}

function buildRetryTask(originalTask: string, validationOutputPath: string, validationArtifact: string): string {
	return [
		originalTask,
		"",
		"Previous quality-gate validation did not pass. Produce a corrected result.",
		`Validator artifact: ${validationOutputPath}`,
		validationArtifact || "(empty validator artifact)",
	].join("\n");
}

async function runQualityGatedSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const executionCwd = options.cwd ?? runtimeCwd;
	let compiled;
	try {
		compiled = compileQualityGate({
			agent,
			agents,
			cwd: executionCwd,
			runId: options.runId,
			maxRetriesOverride: options.qualityGateMaxRetries,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agent: agent.name,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: message,
		};
	}

	const gate = compiled.config;
	const runs: NonNullable<SingleResult["qualityGate"]>["runs"] = [];
	const allResults: SingleResult[] = [];
	let lastProducer: SingleResult | undefined;
	let lastValidationRaw = "";
	let lastPass = false;
	let attempts = 0;

	const gateOptions = (extra?: Partial<RunSyncOptions>): RunSyncOptions => ({
		...options,
		...extra,
		qualityGate: false,
		qualityGateMaxRetries: undefined,
		onUpdate: undefined,
		outputPath: extra?.outputPath,
	});

	const finish = (base: SingleResult, passed: boolean, error?: string, exhausted = false): SingleResult => {
		refreshOutputFromFile(base, options.outputPath);
		base.usage = mergeUsage(allResults);
		base.progressSummary = mergeProgressSummary(allResults);
		base.qualityGate = {
			enabled: true,
			passed,
			exhausted: exhausted || undefined,
			onExhausted: gate.onExhausted,
			attempts,
			currentPhase: runs.at(-1)?.phase,
			validationOutput: compiled.validationOutputPath,
			validatorOutputSchema: compiled.schemaPath,
			lastPass,
			error,
			runs,
		};
		if (!passed && !(exhausted && gate.onExhausted === "continue")) {
			base.exitCode = base.exitCode === 0 ? 1 : base.exitCode;
			base.error = error ?? base.error ?? "Quality gate failed.";
		}
		return base;
	};

	if (gate.maxRetries === 0) {
		const base: SingleResult = {
			agent: agent.name,
			task,
			exitCode: gate.onExhausted === "continue" ? 0 : 1,
			messages: [],
			usage: emptyUsage(),
			error: "Quality gate exhausted before running because maxRetries is 0.",
		};
		return finish(base, false, base.error, true);
	}

	for (let attempt = 1; attempt <= gate.maxRetries; attempt++) {
		attempts = attempt;
		const producerTask = lastValidationRaw
			? buildRetryTask(task, compiled.validationOutputPath, summarizeValidatorArtifact(lastValidationRaw))
			: task;
		const producer = await runPlainSync(runtimeCwd, agents, agent.name, producerTask, gateOptions({ outputPath: options.outputPath }));
		lastProducer = producer;
		allResults.push(producer);
		runs.push({ phase: "producer", agent: agent.name, attempt, exitCode: producer.exitCode, error: producer.error });
		if (producer.exitCode !== 0) {
			return finish(producer, false, producer.error || "Producer failed.");
		}

		const validatorOutputPath = resolveQualityGateOutputPath(gate.validationOutput, executionCwd, {
			runId: options.runId,
			agent: agent.name,
			attempt,
			phase: "validator",
		});
		const validatorTask = buildValidatorTask({
			agentName: agent.name,
			originalTask: task,
			producerOutput: producer.finalOutput ?? "",
			validationOutputPath: validatorOutputPath,
			passField: gate.passField,
			schemaPath: compiled.schemaPath,
			outputPath: options.outputPath,
		});
		const validator = await runPlainSync(runtimeCwd, agents, gate.validator, validatorTask, gateOptions({ outputPath: validatorOutputPath }));
		allResults.push(validator);
		runs.push({ phase: "validator", agent: gate.validator, attempt, exitCode: validator.exitCode, validationOutput: validatorOutputPath, error: validator.error });
		if (validator.exitCode !== 0) {
			return finish(producer, false, validator.error || "Validator failed.");
		}

		let artifact;
		try {
			artifact = readValidatorArtifact(validatorOutputPath, gate.passField, compiled.validateSchema);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			runs[runs.length - 1]!.error = message;
			return finish(producer, false, message);
		}
		lastValidationRaw = artifact.raw;
		lastPass = artifact.pass;
		runs[runs.length - 1]!.pass = artifact.pass;
		if (artifact.pass) return finish(producer, true);

		if (!gate.fixer) {
			const message = "Quality gate did not pass and no fixer is configured.";
			if (attempt === gate.maxRetries) return finish(producer, false, message, true);
			continue;
		}

		const fixerTask = buildFixerTask({
			agentName: agent.name,
			originalTask: task,
			producerOutput: producer.finalOutput ?? "",
			validationOutputPath: validatorOutputPath,
			validationArtifact: summarizeValidatorArtifact(artifact.raw),
			outputPath: options.outputPath,
		});
		const fixer = await runPlainSync(runtimeCwd, agents, gate.fixer, fixerTask, gateOptions());
		allResults.push(fixer);
		runs.push({ phase: "fixer", agent: gate.fixer, attempt, exitCode: fixer.exitCode, error: fixer.error });
		if (fixer.exitCode !== 0) {
			return finish(producer, false, fixer.error || "Fixer failed.");
		}
		refreshOutputFromFile(producer, options.outputPath);

		const postFixValidatorTask = buildValidatorTask({
			agentName: agent.name,
			originalTask: task,
			producerOutput: producer.finalOutput ?? "",
			validationOutputPath: validatorOutputPath,
			passField: gate.passField,
			schemaPath: compiled.schemaPath,
			outputPath: options.outputPath,
		});
		const postFixValidator = await runPlainSync(runtimeCwd, agents, gate.validator, postFixValidatorTask, gateOptions({ outputPath: validatorOutputPath }));
		allResults.push(postFixValidator);
		runs.push({ phase: "validator", agent: gate.validator, attempt, exitCode: postFixValidator.exitCode, validationOutput: validatorOutputPath, error: postFixValidator.error });
		if (postFixValidator.exitCode !== 0) {
			return finish(producer, false, postFixValidator.error || "Validator failed after fixer.");
		}
		try {
			artifact = readValidatorArtifact(validatorOutputPath, gate.passField, compiled.validateSchema);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			runs[runs.length - 1]!.error = message;
			return finish(producer, false, message);
		}
		lastValidationRaw = artifact.raw;
		lastPass = artifact.pass;
		runs[runs.length - 1]!.pass = artifact.pass;
		if (artifact.pass) return finish(producer, true);
	}

	const exhaustedMessage = `Quality gate exhausted after ${gate.maxRetries} attempt${gate.maxRetries === 1 ? "" : "s"}. Last ${gate.passField}=false.`;
	const base = lastProducer ?? {
		agent: agent.name,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: exhaustedMessage,
	};
	return finish(base, false, exhaustedMessage, true);
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return runPlainSync(runtimeCwd, agents, agentName, task, options);
	}
	const gateEnabled = options.qualityGate ?? agent.qualityGate?.enabledByDefault;
	if (agent.qualityGate && gateEnabled !== false) {
		return runQualityGatedSync(runtimeCwd, agents, agent, task, options);
	}
	return runPlainSync(runtimeCwd, agents, agentName, task, options);
}
