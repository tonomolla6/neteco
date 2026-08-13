import { describe, expect, it } from 'vitest'
import { EXPLORATORY_AREAS, validateExploratoryEvidence } from '../../scripts/lib/exploratory-evidence'

function validEvidence() {
  return {
    schemaVersion: 1,
    requirementId: 'TST-034',
    status: 'final',
    run: {
      id: 'alpha-risk-2026-08-13',
      commitSha: 'a'.repeat(40),
      environment: 'local production build with synthetic seed',
      startedAt: '2026-08-13T10:00:00.000Z',
      completedAt: '2026-08-13T11:00:00.000Z',
      testerId: 'tester-01',
      reviewerId: 'reviewer-01'
    },
    evidence: [
      { id: 'run-log', kind: 'log', reference: 'restricted://run-log', outcome: 'pass', summary: 'All checks pass' }
    ],
    charters: EXPLORATORY_AREAS.map((area, index) => ({
      id: `EXP-${String(index + 1).padStart(2, '0')}`,
      area,
      mission: `Explore ${area}`,
      risks: ['Loss of a critical business invariant'],
      heuristics: ['SFDIPOT'],
      setup: ['Synthetic isolated data'],
      timeboxMinutes: 15,
      scenarios: ['Happy path', 'Interrupted or invalid path'],
      result: 'pass',
      observations: [{ kind: 'confirmation', summary: 'Risk controls remained effective' }],
      evidenceIds: ['run-log'],
      defectIds: []
    })),
    defectBacklog: [],
    review: {
      decision: 'reviewed',
      reviewerId: 'reviewer-01',
      reviewedAt: '2026-08-13T12:00:00.000Z',
      notes: 'Scope and results independently reviewed.'
    }
  }
}

describe('risk-guided exploratory evidence', () => {
  it('accepts one complete charter per required area', () => {
    expect(validateExploratoryEvidence(validEvidence(), 'a'.repeat(40))).toMatchObject({
      requirementId: 'TST-034',
      status: 'final'
    })
  })

  it('rejects missing areas, duplicate IDs and broken evidence references', () => {
    const evidence = validEvidence()
    evidence.charters.at(-1)!.area = 'mobile'
    evidence.charters[1]!.id = evidence.charters[0]!.id
    evidence.charters[2]!.evidenceIds = ['missing']
    expect(() => validateExploratoryEvidence(evidence)).toThrow(/operations/)
    expect(() => validateExploratoryEvidence(evidence)).toThrow(/Duplicate charter/)
    expect(() => validateExploratoryEvidence(evidence)).toThrow(/unknown evidence/)
  })

  it('requires every discovered defect to enter the linked backlog', () => {
    const evidence = validEvidence()
    evidence.charters[0]!.result = 'pass_with_defects'
    evidence.charters[0]!.defectIds = ['EXP-DEF-001']
    evidence.charters[0]!.observations = [
      { kind: 'defect', summary: 'Payment retry loses context', defectId: 'EXP-DEF-001' }
    ]
    expect(() => validateExploratoryEvidence(evidence)).toThrow(/missing backlog defect/)

    evidence.defectBacklog = [
      {
        id: 'EXP-DEF-001',
        sourceCharterId: evidence.charters[0]!.id,
        title: 'Payment retry loses context',
        severity: 'P1',
        status: 'open',
        owner: 'checkout-team',
        reproduction: ['Reject a payment', 'Retry from the order page'],
        expected: 'Retry preserves order context',
        actual: 'Context is lost',
        createdAt: '2026-08-13T10:30:00.000Z',
        retestEvidenceIds: []
      }
    ]
    expect(validateExploratoryEvidence(evidence).defectBacklog).toHaveLength(1)
  })

  it('rejects self-review, invalid chronology and mismatched commits', () => {
    const evidence = validEvidence()
    evidence.run.reviewerId = evidence.run.testerId
    evidence.review.reviewerId = evidence.run.testerId
    evidence.review.reviewedAt = '2026-08-13T10:30:00.000Z'
    expect(() => validateExploratoryEvidence(evidence, 'b'.repeat(40))).toThrow(/independent/)
    expect(() => validateExploratoryEvidence(evidence, 'b'.repeat(40))).toThrow(/predates/)
    expect(() => validateExploratoryEvidence(evidence, 'b'.repeat(40))).toThrow(/expected commit/)
  })
})
