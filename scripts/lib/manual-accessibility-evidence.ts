import { z } from 'zod'

export const MANUAL_ACCESSIBILITY_CATEGORIES = [
  'keyboard',
  'focus',
  'screen_reader',
  'zoom_reflow',
  'contrast',
  'errors',
  'authentication'
] as const

const evidenceSchema = z.object({
  schemaVersion: z.literal(1),
  requirementId: z.literal('TST-023'),
  status: z.literal('final'),
  release: z.object({
    id: z.string().trim().min(1).max(80),
    kind: z.literal('major'),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    environmentUrl: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === 'https:', 'Must use HTTPS'),
    deployedAt: z.string().datetime()
  }),
  session: z.object({
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    testerIds: z.array(z.string().trim().min(1).max(120)).min(1),
    reviewerId: z.string().trim().min(1).max(120),
    operatingSystems: z.array(z.string().trim().min(1).max(120)).min(1),
    browsers: z.array(z.string().trim().min(1).max(120)).min(1),
    screenReaders: z.array(z.string().trim().min(1).max(120)).min(1),
    inputMethods: z.array(z.string().trim().min(1).max(120)).min(1),
    viewports: z.array(z.string().trim().min(1).max(120)).min(1)
  }),
  artifacts: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i),
        kind: z.enum(['notes', 'screenshot', 'video', 'screen-reader-log', 'contrast-report']),
        uri: z.string().trim().min(1).max(500),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i)
      })
    )
    .min(1),
  checks: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{1,79}$/i),
        category: z.enum(MANUAL_ACCESSIBILITY_CATEGORIES),
        surface: z.string().trim().min(1).max(200),
        steps: z.array(z.string().trim().min(1).max(500)).min(1),
        expected: z.string().trim().min(1).max(1000),
        result: z.enum(['pass', 'fail']),
        artifactIds: z.array(z.string()).min(1),
        issueId: z.string().trim().min(1).max(120).optional()
      })
    )
    .min(MANUAL_ACCESSIBILITY_CATEGORIES.length),
  defects: z.array(
    z.object({
      id: z.string().trim().min(1).max(120),
      severity: z.enum(['P0', 'P1', 'P2', 'P3']),
      status: z.enum(['open', 'resolved', 'accepted-risk']),
      retestArtifactIds: z.array(z.string()).default([])
    })
  ),
  approval: z.object({
    decision: z.literal('approved'),
    reviewerId: z.string().trim().min(1).max(120),
    reviewedAt: z.string().datetime(),
    notes: z.string().trim().min(1).max(2000)
  })
})

export type ManualAccessibilityEvidence = z.infer<typeof evidenceSchema>

export function validateManualAccessibilityEvidence(value: unknown, expectedCommit?: string) {
  const evidence = evidenceSchema.parse(value)
  const problems: string[] = []
  const checkIds = new Set<string>()
  const artifactIds = new Set<string>()
  const defectIds = new Set<string>()

  for (const artifact of evidence.artifacts) {
    if (artifactIds.has(artifact.id)) problems.push(`Duplicate artifact id: ${artifact.id}`)
    artifactIds.add(artifact.id)
  }
  for (const check of evidence.checks) {
    if (checkIds.has(check.id)) problems.push(`Duplicate check id: ${check.id}`)
    checkIds.add(check.id)
    if (check.result === 'fail') problems.push(`Failed check: ${check.id}`)
    for (const artifactId of check.artifactIds) {
      if (!artifactIds.has(artifactId)) problems.push(`Check ${check.id} references unknown artifact: ${artifactId}`)
    }
  }
  for (const category of MANUAL_ACCESSIBILITY_CATEGORIES) {
    if (!evidence.checks.some((check) => check.category === category && check.result === 'pass')) {
      problems.push(`Missing passing manual check for category: ${category}`)
    }
  }
  for (const defect of evidence.defects) {
    if (defectIds.has(defect.id)) problems.push(`Duplicate defect id: ${defect.id}`)
    defectIds.add(defect.id)
    if (['P0', 'P1'].includes(defect.severity) && defect.status !== 'resolved') {
      problems.push(`Unresolved ${defect.severity} defect: ${defect.id}`)
    }
    if (defect.status === 'resolved' && defect.retestArtifactIds.length === 0) {
      problems.push(`Resolved defect lacks retest evidence: ${defect.id}`)
    }
    for (const artifactId of defect.retestArtifactIds) {
      if (!artifactIds.has(artifactId)) problems.push(`Defect ${defect.id} references unknown artifact: ${artifactId}`)
    }
  }
  if (evidence.session.reviewerId !== evidence.approval.reviewerId) {
    problems.push('Session reviewer and approval reviewer do not match')
  }
  if (evidence.session.testerIds.includes(evidence.session.reviewerId)) {
    problems.push('Manual tester and independent reviewer must be different people')
  }
  if (Date.parse(evidence.release.deployedAt) > Date.parse(evidence.session.startedAt)) {
    problems.push('Manual session starts before the tested commit was deployed')
  }
  if (Date.parse(evidence.session.startedAt) > Date.parse(evidence.session.completedAt)) {
    problems.push('Manual session completes before it starts')
  }
  if (Date.parse(evidence.session.completedAt) > Date.parse(evidence.approval.reviewedAt)) {
    problems.push('Approval predates completion of the manual session')
  }
  if (expectedCommit && evidence.release.commitSha.toLowerCase() !== expectedCommit.toLowerCase()) {
    problems.push(`Evidence commit ${evidence.release.commitSha} does not match expected commit ${expectedCommit}`)
  }
  if (problems.length) throw new Error(`Manual accessibility evidence is not acceptable:\n- ${problems.join('\n- ')}`)
  return evidence
}
