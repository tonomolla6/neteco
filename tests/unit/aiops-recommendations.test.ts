import { describe, expect, it } from 'vitest'
import {
  AIOPS_RUNBOOKS,
  computeAiopsPrecision,
  correlateSignals,
  decideRecommendationSchema,
  ingestSignalSchema,
  type AiopsSignal
} from '../../shared/aiops-recommendations'

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function sig(n: number, over: Partial<AiopsSignal> = {}): AiopsSignal {
  return {
    id: id(n),
    kind: 'error_rate',
    service: 'checkout',
    severity: 'high',
    metricValue: 9,
    thresholdValue: 2,
    observedAt: '2026-10-29T10:00:00Z',
    ...over
  }
}
const OPTS = { windowMinutes: 15 }

describe('AIOps correlation (recommendation only)', () => {
  it('returns nothing for no signals or a single low-severity signal', () => {
    expect(correlateSignals([], OPTS)).toEqual([])
    expect(correlateSignals([sig(1, { severity: 'low' })], OPTS)).toEqual([])
  })

  it('does not propose from one medium/high signal alone', () => {
    expect(correlateSignals([sig(1)], OPTS)).toEqual([])
  })

  it('proposes from a single critical signal', () => {
    const out = correlateSignals([sig(1, { severity: 'critical' })], OPTS)
    expect(out).toHaveLength(1)
    expect(out[0]!.runbookId).toBe('manual_triage')
  })

  it('correlates a deploy with error spikes into a destructive rollback proposal', () => {
    const out = correlateSignals(
      [
        sig(1, { kind: 'deploy', service: 'storefront', severity: 'medium', observedAt: '2026-10-29T09:55:00Z' }),
        sig(2, { kind: 'error_rate', service: 'checkout', observedAt: '2026-10-29T10:00:00Z' })
      ],
      OPTS
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.runbookId).toBe('rollback_release')
    expect(out[0]!.destructive).toBe(true)
    expect(out[0]!.signalIds).toEqual([id(1), id(2)])
    expect(out[0]!.steps.length).toBeGreaterThan(1)
  })

  it('maps payment failures plus provider timeouts to a destructive provider pause', () => {
    const out = correlateSignals(
      [
        sig(1, { kind: 'payment_failures', service: 'payments' }),
        sig(2, { kind: 'provider_timeout', service: 'payments', observedAt: '2026-10-29T10:03:00Z' })
      ],
      OPTS
    )
    expect(out[0]!.runbookId).toBe('pause_payment_provider')
    expect(out[0]!.destructive).toBe(true)
  })

  it('maps queue backlog plus database errors to a non-destructive consumer scale-up', () => {
    const out = correlateSignals(
      [sig(1, { kind: 'queue_backlog', service: 'queues' }), sig(2, { kind: 'db_errors', service: 'database' })],
      OPTS
    )
    expect(out[0]!.runbookId).toBe('scale_queue_consumers')
    expect(out[0]!.destructive).toBe(false)
  })

  it('splits clusters separated by more than the window', () => {
    const out = correlateSignals(
      [
        sig(1, { kind: 'queue_backlog', service: 'queues' }),
        sig(2, { kind: 'db_errors', service: 'database', observedAt: '2026-10-29T10:05:00Z' }),
        sig(3, { kind: 'queue_backlog', service: 'queues', observedAt: '2026-10-29T13:00:00Z' }),
        sig(4, { kind: 'db_errors', service: 'database', observedAt: '2026-10-29T13:02:00Z' })
      ],
      OPTS
    )
    expect(out).toHaveLength(2)
  })

  it('chains signals whose consecutive gaps are within the window', () => {
    const out = correlateSignals(
      [
        sig(1, { kind: 'queue_backlog', service: 'queues', observedAt: '2026-10-29T10:00:00Z' }),
        sig(2, { kind: 'saturation', service: 'database', observedAt: '2026-10-29T10:12:00Z' }),
        sig(3, { kind: 'db_errors', service: 'database', observedAt: '2026-10-29T10:24:00Z' })
      ],
      OPTS
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.signalIds).toHaveLength(3)
  })

  it('is deterministic regardless of input order and has bounded confidence', () => {
    const a = [sig(1, { kind: 'deploy', severity: 'medium' }), sig(2, { kind: 'latency_p95' })]
    const forward = correlateSignals(a, OPTS)
    const reverse = correlateSignals([...a].reverse(), OPTS)
    expect(reverse).toEqual(forward)
    expect(forward[0]!.confidence).toBeGreaterThan(0)
    expect(forward[0]!.confidence).toBeLessThanOrEqual(0.95)
  })

  it('never ranks a runbook as executable: catalogue has no automation flag and destructive ones are marked', () => {
    for (const runbook of Object.values(AIOPS_RUNBOOKS)) {
      expect(runbook.steps.length).toBeGreaterThan(0)
      expect(Object.keys(runbook)).not.toContain('autoExecute')
    }
    expect(AIOPS_RUNBOOKS.rollback_release.destructive).toBe(true)
    expect(AIOPS_RUNBOOKS.pause_payment_provider.destructive).toBe(true)
  })

  it('ignores duplicate signal ids', () => {
    const s = sig(1, { severity: 'critical' })
    const out = correlateSignals([s, s], OPTS)
    expect(out[0]!.signalIds).toEqual([s.id])
  })
})

describe('AIOps precision', () => {
  const rec = (outcome: 'pending' | 'true_positive' | 'false_positive') => ({ outcome })
  it('reports null precision without reviewed outcomes', () => {
    expect(computeAiopsPrecision([rec('pending')])).toMatchObject({ reviewed: 0, precision: null, pending: 1 })
    expect(computeAiopsPrecision([])).toMatchObject({ total: 0, precision: null })
  })
  it('computes precision over reviewed items only', () => {
    const result = computeAiopsPrecision([
      rec('true_positive'),
      rec('true_positive'),
      rec('true_positive'),
      rec('false_positive'),
      rec('pending')
    ])
    expect(result).toMatchObject({ total: 5, reviewed: 4, truePositives: 3, falsePositives: 1, pending: 1 })
    expect(result.precision).toBeCloseTo(0.75, 6)
    expect(result.sampleSufficient).toBe(false)
  })
  it('marks sample sufficient from 10 reviewed items', () => {
    const items = Array.from({ length: 10 }, () => rec('true_positive'))
    expect(computeAiopsPrecision(items).sampleSufficient).toBe(true)
  })
})

describe('AIOps input schemas', () => {
  const base = { commandId: id(90), idempotencyKey: 'k1' }
  it('accepts a valid signal and rejects unknown keys / bad enums / non-finite values', () => {
    const valid = {
      ...base,
      kind: 'error_rate',
      service: 'checkout',
      severity: 'high',
      metricValue: 5,
      thresholdValue: 1,
      observedAt: '2026-10-29T10:00:00Z'
    }
    expect(ingestSignalSchema.safeParse(valid).success).toBe(true)
    expect(ingestSignalSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(ingestSignalSchema.safeParse({ ...valid, kind: 'nope' }).success).toBe(false)
    expect(ingestSignalSchema.safeParse({ ...valid, metricValue: Number.POSITIVE_INFINITY }).success).toBe(false)
    expect(ingestSignalSchema.safeParse({ ...valid, observedAt: '2026-10-29 10:00' }).success).toBe(false)
  })
  it('requires a meaningful reason for decisions', () => {
    const d = { ...base, recommendationId: id(5), expectedVersion: 1, decision: 'approve' }
    expect(decideRecommendationSchema.safeParse({ ...d, reason: 'short' }).success).toBe(false)
    expect(decideRecommendationSchema.safeParse({ ...d, reason: 'reviewed runbook and impact' }).success).toBe(true)
  })
})
