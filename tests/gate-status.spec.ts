import { describe, expect, it } from 'vitest'
import { DRILL_COMMAND, renderDrill, renderGateStatus } from '../src/gate-status.ts'
import type { GateStatus } from '../src/gate-status.ts'

const ARMED: GateStatus = {
  armed: true,
  reviewerProvider: 'blockrun',
  reviewerModel: 'anthropic/claude-opus-5',
  timeoutMs: 20_000,
  onReviewerFailure: 'ask',
  ruleNames: ['recursive-delete', 'force-push'],
}

describe('renderGateStatus', () => {
  it('names the reviewer and the failure posture when armed', () => {
    const text = renderGateStatus(ARMED)
    expect(text).toContain('ARMED')
    expect(text).toContain('anthropic/claude-opus-5')
    expect(text).toContain('escalate to you')
    expect(text).toContain('recursive-delete, force-push')
  })

  it('says a deny posture denies, rather than printing the enum', () => {
    expect(renderGateStatus({ ...ARMED, onReviewerFailure: 'deny' })).toContain('deny the call')
  })

  it('warns that a working /review proves nothing about the gate', () => {
    // The specific wrong inference this command exists to correct.
    const text = renderGateStatus({ ...ARMED, armed: false })
    expect(text).toContain('NOT ARMED')
    expect(text).toContain('/review')
    expect(text).toMatch(/nothing about the gate/)
  })

  it('gives the exact YAML and the patch-layer caveat', () => {
    const text = renderGateStatus({ ...ARMED, armed: false })
    expect(text).toContain('enabled: true')
    expect(text).toContain('anthropic/claude-opus-5')
    // A patch layer replaces the whole config block, so half an edit silently
    // drops the other keys — the mistake that produces a disarmed gate.
    expect(text).toMatch(/replaces that row's whole `config`/)
  })
})

describe('renderDrill', () => {
  const base = { command: DRILL_COMMAND, matchedRule: 'recursive-delete', elapsedMs: 3_140 }

  it('reports a denial as the gate working end to end', () => {
    const text = renderDrill({ ...base, ruling: 'dangerous', reason: 'Erases the filesystem.' })
    expect(text).toContain('flagged by "recursive-delete"')
    expect(text).toContain('ruled "dangerous"')
    expect(text).toContain('would have been denied')
    expect(text).toContain('3.1s')
  })

  it('separates an unreachable reviewer from a verdict', () => {
    // At runtime both become "escalate", which looks exactly like the gate
    // working. Keeping them apart is the drill's whole purpose.
    const text = renderDrill({ ...base, ruling: undefined })
    expect(text).toContain('UNREACHABLE')
    expect(text).not.toContain('ruled')
    expect(text).toMatch(/reviewer does not/)
  })

  it('stops after the matcher when no rule fired, without blaming the reviewer', () => {
    const text = renderDrill({ ...base, matchedRule: undefined, ruling: undefined })
    expect(text).toContain('MISS')
    expect(text).toContain('would not have reviewed it')
    // The preamble names the reviewer as a destination; what must be absent is
    // a verdict stage, since the reviewer was never asked.
    expect(text).not.toContain('2. reviewer')
    expect(text).not.toContain('UNREACHABLE')
  })

  it('flags a reviewer that cleared the drill command', () => {
    const text = renderDrill({ ...base, ruling: 'safe', reason: 'looks fine' })
    expect(text).toMatch(/worth investigating/)
  })

  it('never suggests the drill command was executed', () => {
    expect(renderDrill({ ...base, ruling: 'dangerous' })).toContain('not executed')
  })
})
