import { z } from 'zod'

export const EXPLORATORY_AREAS = ['checkout', 'panel', 'mobile', 'provider_errors', 'operations'] as const

const evidenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i),
  kind: z.enum(['command', 'repository_file', 'log']),
  reference: z.string().trim().min(1).max(500),
  outcome: z.enum(['pass', 'fail', 'info']),
  summary: z.string().trim().min(1).max(1000)
})

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  requirementId: z.literal('TST-034'),
  status: z.literal('final'),
  run: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    environment: z.string().trim().min(1).max(200),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    testerId: z.string().trim().min(1).max(120),
    reviewerId: z.string().trim().min(1).max(120)
  }),
  evidence: z.array(evidenceSchema).min(1),
  charters: z
    .array(
      z.object({
        id: z.string().regex(/^EXP-[A-Z0-9-]{2,60}$/),
        area: z.enum(EXPLORATORY_AREAS),
        mission: z.string().trim().min(1).max(1000),
        risks: z.array(z.string().trim().min(1).max(500)).min(1),
        heuristics: z.array(z.string().trim().min(1).max(120)).min(1),
        setup: z.array(z.string().trim().min(1).max(500)).min(1),
        timeboxMinutes: z.number().int().min(5).max(240),
        scenarios: z.array(z.string().trim().min(1).max(500)).min(2),
        result: z.enum(['pass', 'pass_with_defects', 'blocked']),
        observations: z
          .array(
            z.object({
              kind: z.enum(['confirmation', 'risk', 'defect']),
              summary: z.string().trim().min(1).max(1000),
              defectId: z.string().trim().min(1).max(120).optional()
            })
          )
          .min(1),
        evidenceIds: z.array(z.string()).min(1),
        defectIds: z.array(z.string()).default([])
      })
    )
    .min(EXPLORATORY_AREAS.length),
  defectBacklog: z.array(
    z.object({
      id: z.string().regex(/^EXP-DEF-[0-9]{3,}$/),
      sourceCharterId: z.string(),
      title: z.string().trim().min(1).max(300),
      severity: z.enum(['P0', 'P1', 'P2', 'P3']),
      status: z.enum(['open', 'resolved', 'accepted-risk']),
      owner: z.string().trim().min(1).max(120),
      reproduction: z.array(z.string().trim().min(1).max(500)).min(1),
      expected: z.string().trim().min(1).max(1000),
      actual: z.string().trim().min(1).max(1000),
      createdAt: z.string().datetime(),
      retestEvidenceIds: z.array(z.string()).default([])
    })
  ),
  review: z.object({
    decision: z.literal('reviewed'),
    reviewerId: z.string().trim().min(1).max(120),
    reviewedAt: z.string().datetime(),
    notes: z.string().trim().min(1).max(2000)
  })
})

export type ExploratoryEvidence = z.infer<typeof manifestSchema>

export function validateExploratoryEvidence(value: unknown, expectedCommit?: string) {
  const manifest = manifestSchema.parse(value)
  const problems: string[] = []
  const evidenceIds = new Set<string>()
  const charterIds = new Set<string>()
  const defectIds = new Set<string>()

  for (const evidence of manifest.evidence) {
    if (evidenceIds.has(evidence.id)) problems.push(`Duplicate evidence id: ${evidence.id}`)
    evidenceIds.add(evidence.id)
  }
  for (const charter of manifest.charters) {
    if (charterIds.has(charter.id)) problems.push(`Duplicate charter id: ${charter.id}`)
    charterIds.add(charter.id)
    for (const evidenceId of charter.evidenceIds) {
      if (!evidenceIds.has(evidenceId))
        problems.push(`Charter ${charter.id} references unknown evidence: ${evidenceId}`)
    }
    if (charter.result === 'pass' && charter.defectIds.length > 0) {
      problems.push(`Passing charter ${charter.id} cannot hide defects`)
    }
    if (charter.result !== 'pass' && charter.defectIds.length === 0) {
      problems.push(`Charter ${charter.id} requires a backlog defect`)
    }
    for (const observation of charter.observations) {
      if (observation.kind === 'defect' && !observation.defectId) {
        problems.push(`Defect observation in ${charter.id} lacks defectId`)
      }
      if (observation.defectId && !charter.defectIds.includes(observation.defectId)) {
        problems.push(`Observation in ${charter.id} references an unlisted defect: ${observation.defectId}`)
      }
    }
  }
  for (const area of EXPLORATORY_AREAS) {
    const matches = manifest.charters.filter((charter) => charter.area === area)
    if (matches.length !== 1) problems.push(`Expected exactly one charter for area: ${area}`)
  }
  for (const defect of manifest.defectBacklog) {
    if (defectIds.has(defect.id)) problems.push(`Duplicate defect id: ${defect.id}`)
    defectIds.add(defect.id)
    const source = manifest.charters.find((charter) => charter.id === defect.sourceCharterId)
    if (!source) problems.push(`Defect ${defect.id} references unknown charter: ${defect.sourceCharterId}`)
    else if (!source.defectIds.includes(defect.id))
      problems.push(`Defect ${defect.id} is missing from its source charter`)
    for (const evidenceId of defect.retestEvidenceIds) {
      if (!evidenceIds.has(evidenceId))
        problems.push(`Defect ${defect.id} references unknown retest evidence: ${evidenceId}`)
    }
    if (defect.status === 'resolved' && defect.retestEvidenceIds.length === 0) {
      problems.push(`Resolved defect ${defect.id} lacks retest evidence`)
    }
  }
  for (const charter of manifest.charters) {
    for (const defectId of charter.defectIds) {
      if (!defectIds.has(defectId))
        problems.push(`Charter ${charter.id} references missing backlog defect: ${defectId}`)
    }
  }
  if (manifest.run.testerId === manifest.run.reviewerId) problems.push('Tester and reviewer must be independent')
  if (manifest.run.reviewerId !== manifest.review.reviewerId) problems.push('Run reviewer and review do not match')
  if (Date.parse(manifest.run.startedAt) > Date.parse(manifest.run.completedAt)) {
    problems.push('Exploratory run completes before it starts')
  }
  if (Date.parse(manifest.run.completedAt) > Date.parse(manifest.review.reviewedAt)) {
    problems.push('Review predates completion of the exploratory run')
  }
  if (expectedCommit && manifest.run.commitSha.toLowerCase() !== expectedCommit.toLowerCase()) {
    problems.push(`Evidence commit ${manifest.run.commitSha} does not match expected commit ${expectedCommit}`)
  }
  if (problems.length) throw new Error(`Exploratory evidence is not acceptable:\n- ${problems.join('\n- ')}`)
  return manifest
}
