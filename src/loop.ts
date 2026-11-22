import { DEFAULT_MAX_REPEATS } from './config.ts'
import type { Scoring } from './convergence.ts'
import type { Issue } from './issue.ts'
import { issueFingerprint, isAbortError, severityCounts } from './issue.ts'
import type { LlmPort } from './llm-port.ts'
import { withSingleRetry } from './llm-port.ts'
import { assembleGeneratorPrompt, assembleRepairPrompt, estimateTokens, extractJson, type MaterialTag } from './prompt.ts'
import { sha256, type ReceiptRound } from './receipt.ts'

/** Loop-internal issue rule ids; ride the same repair path as pack rules. */
export const INTERNAL_INVALID_OUTPUT = 'internal/invalid-output'
export const INTERNAL_LLM_ERROR = 'internal/llm-error'

/** Why the loop gave up (never present on green results). */
export type LoopExhaustReason = 'stagnation' | 'decline' | 'fingerprint-repeat' | 'max-iterations' | 'llm-error'

export interface LoopOptions {
  readonly llm: LlmPort
  readonly promptTemplate: string
  readonly materials: readonly (string | MaterialTag)[]
  readonly upstream?: readonly string[] | undefined
  /** Effective pack params; rendered into the {{params}} slot of every round's prompt. */
  readonly params?: Readonly<Record<string, unknown>> | undefined
  /** Declared overridable param names; renders the materials-may-adjust hint after the params block. */
  readonly overridableParams?: readonly string[] | undefined
  readonly maxIterations: number
  readonly promptTokenBudget: number
  readonly model: string
  readonly signal?: AbortSignal | undefined
  /** Validates the current artifact; returns issues ([] = all green). */
  validate(artifact: unknown): readonly Issue[]
  /** Early-exit policy (docs/designs/convergence-detection.md); defaults to the loose fingerprint fallback. */
  scoring?: Scoring | undefined
}

export interface LoopRoundEvent {
  readonly round: number
  readonly promptTokens: number
  readonly errorCount: number
  readonly warningCount: number
  readonly fingerprintsMatchedPrevious: boolean
  /** Convergence score of the round (score mode only, 0-100). */
  readonly score?: number
}

export interface LoopSuccess {
  readonly status: 'green'
  readonly artifact: unknown
  readonly iterations: number
  readonly rounds: ReceiptRound[]
  readonly events: LoopRoundEvent[]
}

export interface LoopExhausted {
  readonly status: 'exhausted'
  /** Last draft kept for manual rescue; NOT an official artifact (red receipt). */
  readonly draftArtifact: unknown
  readonly iterations: number
  readonly rounds: ReceiptRound[]
  readonly events: LoopRoundEvent[]
  readonly unresolved: Issue[]
  readonly reason: LoopExhaustReason
}

export type LoopResult = LoopSuccess | LoopExhausted

/**
 * The closed repair loop: generate → validate → repair-until-green.
 * Early exit only — green stays "0 error issues"; convergence scoring
 * (stagnation vs best-so-far, strict decline, loose fingerprint repeats)
 * decides when to stop burning rounds. Every round persists through the
 * round event sink so a crash never loses the draft.
 */
export async function runRepairLoop(
  options: LoopOptions,
  onRound: (event: LoopRoundEvent, artifact: unknown) => void,
): Promise<LoopResult> {
  const scoring: Scoring = options.scoring ?? { kind: 'fingerprint', stagnantRounds: 0, decliningRounds: 0, maxRepeats: DEFAULT_MAX_REPEATS, epsilon: 0 }
  const rounds: ReceiptRound[] = []
  const events: LoopRoundEvent[] = []
  let previousFingerprint = ''
  let repeatStreak = 0
  let bestScore = Number.NEGATIVE_INFINITY
  let stagnantCount = 0
  let decliningCount = 0
  let previousScore: number | undefined

  let artifact: unknown
  const originalRequest = assembleGeneratorPrompt({
    promptTemplate: options.promptTemplate,
    materials: options.materials,
    upstream: options.upstream,
    params: options.params,
    overridableParams: options.overridableParams,
  })
  let request = originalRequest
  let iterations = 0

  while (iterations < options.maxIterations) {
    const budget = estimateTokens(request) + estimateTokens(JSON.stringify(artifact ?? ''))
    if (budget > options.promptTokenBudget) {
      throw new Error(`repair prompt exceeds token budget (${budget} > ${options.promptTokenBudget}); partition the materials or raise promptTokenBudget in config`)
    }
    options.signal?.throwIfAborted()

    iterations++
    let text: string
    try {
      text = await withSingleRetry(() => options.llm.complete({ system: '', user: request, signal: options.signal }))
    } catch (error) {
      if (isAbortError(error)) throw error
      const llmIssues: Issue[] = [{
        ruleId: INTERNAL_LLM_ERROR,
        severity: 'error',
        jsonPath: '$',
        message: `model call failed: ${(error as Error).message}`,
        suggestion: 'Retry the doc_generate call; if it persists, check provider config (provider/model) and network.',
      }]
      const counts = severityCounts(llmIssues)
      const ev: LoopRoundEvent = { round: iterations, promptTokens: budget, errorCount: counts.errors, warningCount: counts.warnings, fingerprintsMatchedPrevious: false }
      events.push(ev)
      rounds.push({ round: iterations, errorCount: counts.errors, warningCount: counts.warnings, promptHash: sha256(request) })
      onRound(ev, artifact ?? null)
      return { status: 'exhausted', draftArtifact: artifact ?? null, iterations, rounds, events, unresolved: llmIssues, reason: 'llm-error' }
    }

    let parseIssue: Issue | undefined
    try {
      artifact = extractJson(text)
    } catch (error) {
      parseIssue = {
        ruleId: INTERNAL_INVALID_OUTPUT,
        severity: 'error',
        jsonPath: '$',
        message: (error as Error).message,
        suggestion: 'Return the complete JSON document as the entire reply, no prose around it.',
      }
      artifact = artifact ?? null
    }

    const issues = parseIssue === undefined ? options.validate(artifact) : [parseIssue]
    const counts = severityCounts(issues)
    const fingerprint = issueFingerprint(issues)
    const repeated = fingerprint === previousFingerprint
    previousFingerprint = fingerprint
    const score = scoring.kind === 'score' ? scoring.scorer!(artifact, issues) : undefined

    const ev: LoopRoundEvent = {
      round: iterations,
      promptTokens: budget,
      errorCount: counts.errors,
      warningCount: counts.warnings,
      fingerprintsMatchedPrevious: repeated,
      ...(score === undefined ? {} : { score }),
    }
    events.push(ev)
    rounds.push({ round: iterations, errorCount: counts.errors, warningCount: counts.warnings, ...(score === undefined ? {} : { score }), promptHash: sha256(request) })
    onRound(ev, artifact)

    if (counts.errors === 0) {
      return { status: 'green', artifact, iterations, rounds, events }
    }

    if (scoring.kind === 'score') {
      const s = score!
      if (s > bestScore + scoring.epsilon) {
        bestScore = s
        stagnantCount = 0
      } else {
        stagnantCount++
      }
      if (previousScore !== undefined && s < previousScore) decliningCount++
      else decliningCount = 0
      previousScore = s
      if (decliningCount >= scoring.decliningRounds) {
        return { status: 'exhausted', draftArtifact: artifact, iterations, rounds, events, unresolved: [...issues], reason: 'decline' }
      }
      if (stagnantCount >= scoring.stagnantRounds) {
        return { status: 'exhausted', draftArtifact: artifact, iterations, rounds, events, unresolved: [...issues], reason: 'stagnation' }
      }
    } else {
      repeatStreak = repeated ? repeatStreak + 1 : 0
      if (repeatStreak >= scoring.maxRepeats - 1) {
        return { status: 'exhausted', draftArtifact: artifact, iterations, rounds, events, unresolved: [...issues], reason: 'fingerprint-repeat' }
      }
    }

    request = assembleRepairPrompt({
      promptTemplate: options.promptTemplate,
      originalRequest,
      artifact,
      issues,
    })
  }
  return {
    status: 'exhausted',
    draftArtifact: artifact ?? null,
    iterations,
    rounds,
    events,
    unresolved: [...options.validate(artifact ?? null)],
    reason: 'max-iterations',
  }
}
