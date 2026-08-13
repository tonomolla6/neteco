import { describe, expect, it } from 'vitest'
import {
  MANUAL_ACCESSIBILITY_CATEGORIES,
  validateManualAccessibilityEvidence
} from '../../scripts/lib/manual-accessibility-evidence'

const artifact = {
  id: 'session-notes',
  kind: 'notes' as const,
  uri: 'evidence://accessibility/release-2026-08/session-notes',
  sha256: 'a'.repeat(64)
}

function validEvidence() {
  return {
    schemaVersion: 1,
    requirementId: 'TST-023',
    status: 'final',
    release: {
      id: 'alpha-2026-08',
      kind: 'major',
      commitSha: 'b'.repeat(40),
      environmentUrl: 'https://staging.neteco.example',
      deployedAt: '2026-08-13T10:00:00.000Z'
    },
    session: {
      startedAt: '2026-08-13T11:00:00.000Z',
      completedAt: '2026-08-13T13:00:00.000Z',
      testerIds: ['accessibility-tester-01'],
      reviewerId: 'release-reviewer-01',
      operatingSystems: ['Windows 11 25H2'],
      browsers: ['Firefox 142'],
      screenReaders: ['NVDA 2026.1'],
      inputMethods: ['keyboard-only'],
      viewports: ['1280x720 at 400% zoom']
    },
    artifacts: [artifact],
    checks: MANUAL_ACCESSIBILITY_CATEGORIES.map((category, index) => ({
      id: `A11Y-${String(index + 1).padStart(2, '0')}`,
      category,
      surface: 'Tienda y checkout sintéticos',
      steps: ['Completar la tarea definida en el checklist de la release'],
      expected: 'La tarea se completa y toda la información permanece perceptible y operable',
      result: 'pass',
      artifactIds: [artifact.id]
    })),
    defects: [],
    approval: {
      decision: 'approved',
      reviewerId: 'release-reviewer-01',
      reviewedAt: '2026-08-13T14:00:00.000Z',
      notes: 'Checklist revisado y evidencia íntegra.'
    }
  }
}

describe('manual accessibility evidence', () => {
  it('accepts a complete signed major-release manifest', () => {
    expect(validateManualAccessibilityEvidence(validEvidence(), 'b'.repeat(40))).toMatchObject({
      requirementId: 'TST-023',
      status: 'final'
    })
  })

  it('rejects missing categories, failed checks and broken artifact references', () => {
    const evidence = validEvidence()
    evidence.checks[0]!.category = 'focus'
    evidence.checks[0]!.result = 'fail'
    evidence.checks[1]!.artifactIds = ['missing-artifact']
    expect(() => validateManualAccessibilityEvidence(evidence)).toThrow(/Missing passing manual check for category/)
    expect(() => validateManualAccessibilityEvidence(evidence)).toThrow(/Failed check/)
    expect(() => validateManualAccessibilityEvidence(evidence)).toThrow(/unknown artifact/)
  })

  it('rejects unresolved high-priority defects, unsigned reviews and the wrong release commit', () => {
    const evidence = validEvidence()
    evidence.defects = [{ id: 'A11Y-123', severity: 'P1', status: 'open', retestArtifactIds: [] }]
    evidence.approval.reviewerId = 'different-reviewer'
    expect(() => validateManualAccessibilityEvidence(evidence, 'c'.repeat(40))).toThrow(/Unresolved P1/)
    expect(() => validateManualAccessibilityEvidence(evidence, 'c'.repeat(40))).toThrow(/do not match/)
    expect(() => validateManualAccessibilityEvidence(evidence, 'c'.repeat(40))).toThrow(/expected commit/)
  })
})
