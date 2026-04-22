# Plan: Quality Gate Validation Output + Fixer Input Artifact Files

## Goal
Store quality-gate validation output snapshots and fixer input prompts as auto-named files under existing session artifact directory, without changing user-configured `qualityGate.validationOutput` path semantics.

## Proposed file name scheme
Base existing artifact naming on `{runId}_{agent}`.

Add helper-generated quality-gate artifact files like:
- `{runId}_{agent}_qg_attempt-{N}_validator-output.json`
- `{runId}_{agent}_qg_attempt-{N}_validator-postfix-output.json`
- `{runId}_{agent}_qg_attempt-{N}_fixer-input.md`
- optional later: `{runId}_{agent}_qg_attempt-{N}_producer-retry-input.md`

Notes:
- `agent` = producer agent name, not validator/fixer agent name. Keeps all gate artifacts grouped under one logical run.
- `attempt-{N}` stays 1-based, matching current quality-gate attempt numbering.
- `validator-postfix-output` distinguishes second validator run after fixer in same attempt.
- validation snapshot should preserve raw file contents exactly, even if malformed JSON.

## Scope
Do not change execution behavior.
Do not change configured validator output destination.
Do not change existing `_input.md`, `_output.md`, `_meta.json` naming.
Only add extra artifact files when artifacts are enabled.

## Implementation plan

### 1. Add artifact path helper
File: `artifacts.ts`

Add small helper for quality-gate artifact filenames, something like:
- input: `artifactsDir`, `runId`, `agent`, `attempt`, `kind`
- output: absolute path

Helper should:
- sanitize `agent`
- sanitize `kind`
- keep naming deterministic
- use artifact directory already used by current run

Example API:
- `getQualityGateArtifactPath(dir, runId, agent, attempt, kind, ext)`

### 2. Sync path: snapshot validator output
File: `execution.ts`

Inside `runQualityGatedSync(...)`:
- after each validator run completes, before `readValidatorArtifact(...)`, read configured validator output file if present
- write raw contents to auto-named artifact file in `options.artifactsDir`
- do this for both:
  - first validator run in attempt
  - post-fixer validator run in same attempt

Reason:
- validator output path may be reused and overwritten across attempts
- artifact snapshot preserves exact per-phase output for later inspection
- malformed JSON still gets captured before parser throws

### 3. Sync path: snapshot fixer input
File: `execution.ts`

Before fixer run:
- build `fixerTask` as today
- if artifacts enabled and `options.artifactsDir` exists, write full fixer task prompt to generated artifact file
- file should be markdown/text prompt snapshot

Reason:
- current fixer input only exists in transient task string and session log
- explicit artifact file makes debugging easier and searchable

### 4. Async path parity
File: `subagent-runner.ts`

Mirror same behavior in async/background runner:
- write validator output snapshots after validator and post-fix validator phases
- write fixer input snapshot before fixer phase

Reason:
- sync and async artifact behavior should match
- avoids confusing differences between foreground and background runs

### 5. Metadata decision
Include generated quality-gate artifact file paths in final `_meta.json`.

Add `qualityGateArtifacts` object to final metadata, for example:

```json
{
  "qualityGateArtifacts": {
    "attempts": {
      "1": {
        "validatorOutput": "..._qg_attempt-1_validator-output.json",
        "fixerInput": "..._qg_attempt-1_fixer-input.md",
        "postFixValidatorOutput": "..._qg_attempt-1_validator-postfix-output.json"
      },
      "2": {
        "validatorOutput": "..._qg_attempt-2_validator-output.json"
      }
    }
  }
}
```

Notes:
- store only files actually created
- use artifact file paths, not configured working-path aliases
- keep structure keyed by attempt number for deterministic lookup
- do not add these paths to `ArtifactPaths` yet unless renderer needs them

Reason:
- metadata should act as index for all generated quality-gate artifact files
- makes later UI, debugging, and tooling much easier without scanning directory contents

### 6. Tests
Files:
- `test/integration/single-execution.test.ts`
- async test file if async quality-gate coverage exists or can be added cheaply

Add sync test covering:
- artifacts enabled
- producer fails validation
- fixer runs
- post-fix validator runs
- expected files exist:
  - attempt-1 validator output snapshot
  - attempt-1 fixer input snapshot
  - attempt-1 post-fix validator output snapshot
- validator snapshot content matches raw validator output exactly
- fixer input file contains full fixer prompt text
- final `_meta.json` contains `qualityGateArtifacts` object with correct per-attempt paths

If async test added, assert same files created in async artifact dir.

### 7. Docs
File: `README.md`

Add short note under Artifacts section:
- quality-gated runs also write per-attempt validator output snapshots and fixer input prompts
- clarify these are snapshots in artifact dir, separate from configured `validationOutput` working file

## Edge cases
- Artifacts disabled: write nothing extra
- Missing validator output file: skip snapshot silently or record in metadata later
- Malformed validator JSON: still snapshot raw contents, then existing parser error path continues
- Multiple attempts: each attempt gets separate files
- No fixer configured: no fixer input file
- Fixer fails before changing anything: fixer input file still exists

## Suggested rollout order
1. `artifacts.ts` helper
2. `execution.ts` sync implementation
3. sync integration test
4. `subagent-runner.ts` async implementation
5. README note
6. verify metadata shape in docs/examples if needed

## Acceptance criteria
- No code-path behavior changes beyond additional artifact files
- Existing tests stay green
- Quality-gated sync runs produce per-attempt validator output snapshots
- Quality-gated sync runs with fixer produce fixer input snapshot
- Final `_meta.json` includes `qualityGateArtifacts` index with per-attempt file paths
- Async runner matches sync behavior
- Filenames deterministic and human-readable
