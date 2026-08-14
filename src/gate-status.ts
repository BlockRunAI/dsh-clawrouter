/**
 * Rendering for the `/gate` command.
 *
 * A safety feature that is silently off is worse than one that was never
 * installed, because the person relying on it has stopped watching. This gate
 * can end up off in a way that looks fine from every angle a user can see:
 * `enabled` defaults to `false`, a patch layer replaces a row's whole `config`
 * rather than merging keys, and the `/review` command registers either way —
 * so `/review` answering is evidence the plugin loaded and no evidence at all
 * that tool calls are being inspected.
 *
 * These functions are pure so the harness can render them live and on replay.
 */

/** What the gate is doing right now, as the running plugin sees it. */
export interface GateStatus {
  /** Whether the `tools/pre-execute` listener is registered. */
  readonly armed: boolean
  /** Provider the reviewer model is called through. */
  readonly reviewerProvider: string
  /** Model asked to rule on a flagged call. */
  readonly reviewerModel: string
  /** Deadline for one review, in milliseconds. */
  readonly timeoutMs: number
  /** Ruling used when the reviewer cannot be reached. */
  readonly onReviewerFailure: 'ask' | 'deny'
  /** Names of every active risk rule, defaults and configured alike. */
  readonly ruleNames: readonly string[]
}

/** Outcome of one end-to-end drill against the live reviewer. */
export interface DrillResult {
  /** The command put through the gate. Never executed. */
  readonly command: string
  /** Rule that flagged it, or `undefined` if the matcher let it through. */
  readonly matchedRule: string | undefined
  /** The reviewer's ruling, or `undefined` if it was never reached. */
  readonly ruling: 'safe' | 'dangerous' | 'uncertain' | undefined
  /** The reviewer's stated reason, when it gave one. */
  readonly reason?: string
  /** Wall-clock time for the whole drill. */
  readonly elapsedMs: number
}

/**
 * A command that must be flagged by any policy worth running, used as the
 * drill subject. It is passed to the matcher and quoted to the reviewer; it is
 * never handed to a tool.
 */
export const DRILL_COMMAND = 'rm -rf / --no-preserve-root'

/**
 * Describe the gate's current state.
 *
 * @param status - The running configuration.
 * @returns Text for the command surface.
 */
export function renderGateStatus(status: GateStatus): string {
  if (!status.armed) {
    return [
      'Safety gate: NOT ARMED.',
      '',
      'No tool call is being reviewed. If you expected otherwise, note that the',
      '`/review` command registers whether or not the gate is on, so `/review`',
      'answering tells you the plugin loaded and nothing about the gate.',
      '',
      'Arm it in your profile\'s cordis.patch.yml:',
      '',
      '    - id: blockrun-review',
      '      config:',
      '        enabled: true',
      `        reviewerModel: ${status.reviewerModel}`,
      '',
      'A patch layer replaces that row\'s whole `config`, so restate every key',
      'you need. Then restart and run /gate again.',
    ].join('\n')
  }
  return [
    'Safety gate: ARMED.',
    '',
    `  reviewer     ${status.reviewerModel} via ${status.reviewerProvider}`,
    `  timeout      ${status.timeoutMs} ms`,
    `  on failure   ${status.onReviewerFailure === 'deny' ? 'deny the call' : 'escalate to you'}`,
    `  rules        ${status.ruleNames.length}: ${status.ruleNames.join(', ')}`,
    '',
    'Run `/gate drill` to put a dangerous command through the live reviewer and',
    'see the verdict. It costs one reviewer call and executes nothing.',
  ].join('\n')
}

/**
 * Report a drill, stage by stage.
 *
 * Both stages are reported separately because they fail for unrelated reasons:
 * a rule that no longer matches is a policy problem, and a reviewer that
 * cannot be reached is a wallet or model problem.
 *
 * @param result - What the drill observed.
 * @returns Text for the command surface.
 */
export function renderDrill(result: DrillResult): string {
  const lines = [
    `Drill: ${result.command}`,
    '(not executed — sent to the risk matcher and the reviewer only)',
    '',
    result.matchedRule === undefined
      ? '  1. risk matcher   MISS — no rule flagged this. The gate would not have reviewed it.'
      : `  1. risk matcher   flagged by "${result.matchedRule}"`,
  ]
  if (result.matchedRule === undefined) {
    lines.push('', 'The gate is armed but this command would have gone straight through.')
    return lines.join('\n')
  }
  lines.push(
    result.ruling === undefined
      ? '  2. reviewer       UNREACHABLE — every flagged call would escalate or be denied.'
      : `  2. reviewer       ruled "${result.ruling}"`,
  )
  if (result.reason !== undefined && result.reason.length > 0) lines.push(`     ${result.reason}`)
  lines.push('', `Elapsed ${(result.elapsedMs / 1000).toFixed(1)}s.`)
  lines.push(
    result.ruling === 'dangerous'
      ? 'End to end: this command would have been denied before running.'
      : result.ruling === undefined
        ? 'The matcher works; the reviewer does not. Check reviewerModel and your wallet.'
        : `The reviewer did not call this dangerous. That is worth investigating before relying on the gate.`,
  )
  return lines.join('\n')
}
