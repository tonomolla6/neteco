import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { z } from 'zod'
import { validateOperationalUatInventoryArtifact } from './operational-uat-inventory'

export const OPERATIONAL_UAT_ROLES = ['warehouse', 'administration', 'support'] as const
export const OPERATIONAL_UAT_SIGNOFF_ROLES = [...OPERATIONAL_UAT_ROLES, 'release_manager'] as const
export const OPERATIONAL_UAT_PARTICIPANT_ROLES = [
  ...OPERATIONAL_UAT_SIGNOFF_ROLES,
  'application_operator',
  'defect_owner'
] as const
const REQUIRED_UAT_PARTICIPANT_ROLES = [...OPERATIONAL_UAT_SIGNOFF_ROLES, 'application_operator'] as const

export const OPERATIONAL_UAT_SCRIPTS = {
  'UAT-WH-001': 'warehouse',
  'UAT-WH-002': 'warehouse',
  'UAT-WH-003': 'warehouse',
  'UAT-ADM-001': 'administration',
  'UAT-ADM-002': 'administration',
  'UAT-ADM-003': 'administration',
  'UAT-SUP-001': 'support',
  'UAT-SUP-002': 'support',
  'UAT-SUP-003': 'support'
} as const

const scriptIdSchema = z.enum(Object.keys(OPERATIONAL_UAT_SCRIPTS) as [string, ...string[]])
const roleSchema = z.enum(OPERATIONAL_UAT_ROLES)
const signoffRoleSchema = z.enum(OPERATIONAL_UAT_SIGNOFF_ROLES)
const participantRoleSchema = z.enum(OPERATIONAL_UAT_PARTICIPANT_ROLES)
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,119}$/i)
const artifactIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/i)
const preflightProbeIds = ['live-version', 'ready-dependencies', 'storefront-noindex', 'catalog', 'robots'] as const
const preflightProbePaths: Record<(typeof preflightProbeIds)[number], string> = {
  'live-version': '/api/health/live',
  'ready-dependencies': '/api/health/ready',
  'storefront-noindex': '/',
  catalog: '/api/products?limit=1',
  robots: '/robots.txt'
}

const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementId: z.literal('TST-040'),
    environment: z.literal('staging'),
    syntheticDataOnly: z.literal(true),
    blockingSeverities: z.tuple([z.literal('P0'), z.literal('P1')]),
    scripts: z
      .array(
        z
          .object({
            id: scriptIdSchema,
            role: roleSchema,
            title: z.string().trim().min(10).max(200),
            preconditions: z.array(z.string().trim().min(5).max(500)).min(1),
            steps: z.array(z.string().trim().min(5).max(500)).min(2),
            expected: z.array(z.string().trim().min(5).max(500)).min(1),
            cleanup: z.array(z.string().trim().min(5).max(500)).min(1)
          })
          .strict()
      )
      .length(Object.keys(OPERATIONAL_UAT_SCRIPTS).length)
  })
  .strict()

const evidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementId: z.literal('TST-040'),
    status: z.literal('final'),
    release: z
      .object({
        id: identifierSchema,
        commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
        environment: z.literal('staging'),
        environmentUrl: z.string().url(),
        deployedAt: z.string().datetime()
      })
      .strict(),
    run: z
      .object({
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime()
      })
      .strict(),
    participants: z
      .array(
        z
          .object({
            id: identifierSchema,
            roles: z.array(participantRoleSchema).min(1)
          })
          .strict()
      )
      .min(OPERATIONAL_UAT_SIGNOFF_ROLES.length),
    artifacts: z
      .array(
        z
          .object({
            id: artifactIdSchema,
            kind: z.enum([
              'notes',
              'screenshot',
              'video',
              'export',
              'log',
              'retest',
              'inventory-evidence',
              'approval-record',
              'staging-preflight'
            ]),
            storage: z.enum(['repository', 'external']),
            uri: z.string().trim().min(3).max(500),
            sha256: z.string().regex(/^[0-9a-f]{64}$/i),
            recordedAt: z.string().datetime()
          })
          .strict()
      )
      .min(1),
    results: z
      .array(
        z
          .object({
            scriptId: scriptIdSchema,
            testerId: identifierSchema,
            executorId: identifierSchema,
            result: z.enum(['pass', 'fail', 'blocked']),
            artifactIds: z.array(artifactIdSchema).min(1),
            defectIds: z.array(identifierSchema).default([]),
            notes: z.string().trim().min(3).max(2000)
          })
          .strict()
      )
      .length(Object.keys(OPERATIONAL_UAT_SCRIPTS).length),
    defects: z.array(
      z
        .object({
          id: identifierSchema,
          severity: z.enum(['P0', 'P1', 'P2', 'P3']),
          status: z.enum(['open', 'resolved', 'accepted-risk']),
          ownerId: identifierSchema,
          scriptIds: z.array(scriptIdSchema).min(1),
          resolvedAt: z.string().datetime().nullable(),
          retestArtifactIds: z.array(artifactIdSchema).default([])
        })
        .strict()
    ),
    signoffs: z
      .array(
        z
          .object({
            role: signoffRoleSchema,
            signerId: identifierSchema,
            decision: z.literal('approved'),
            signedAt: z.string().datetime(),
            criteriaDigest: z.string().regex(/^[0-9a-f]{64}$/i),
            approvalPayloadDigest: z.string().regex(/^[0-9a-f]{64}$/i),
            approvalArtifactId: artifactIdSchema
          })
          .strict()
      )
      .length(OPERATIONAL_UAT_SIGNOFF_ROLES.length),
    trafficDecision: z
      .object({
        decision: z.literal('approved'),
        currentPercent: z.number().int().min(0).max(99),
        targetPercent: z.number().int().min(1).max(100),
        releaseManagerId: identifierSchema,
        approvedAt: z.string().datetime(),
        validUntil: z.string().datetime()
      })
      .strict()
  })
  .strict()

export type OperationalUatPolicy = z.infer<typeof policySchema>
export type OperationalUatEvidence = z.infer<typeof evidenceSchema>

const preflightSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirementId: z.literal('TST-040'),
    kind: z.literal('staging-preflight'),
    generatedAt: z.string().datetime(),
    environmentUrl: z.string().url(),
    expectedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
    status: z.literal('pass'),
    probes: z
      .array(
        z
          .object({
            id: z.enum(preflightProbeIds),
            path: z.string().trim().min(1).max(200),
            status: z.number().int().min(100).max(599),
            durationMs: z.number().nonnegative(),
            pass: z.literal(true),
            detail: z.string().trim().min(1).max(500)
          })
          .strict()
      )
      .length(preflightProbeIds.length)
  })
  .strict()

function governedHttpsOrigin(value: string) {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(unwrappedHostname) !== 0 ||
    ['localhost', '127.0.0.1', '::1', 'example', 'invalid', 'test'].includes(hostname) ||
    ['.localhost', '.example', '.invalid', '.test'].some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('Operational UAT requires a real credential-free staging HTTPS URL')
  }
  url.hostname = hostname
  return url.origin
}

export function operationalUatStagingOrigin(value: string, productionUrl?: string) {
  const stagingOrigin = governedHttpsOrigin(value)
  if (productionUrl && stagingOrigin === governedHttpsOrigin(productionUrl)) {
    throw new Error('Operational UAT staging origin must differ from production')
  }
  return stagingOrigin
}

export function validateOperationalUatPolicy(value: unknown) {
  const policy = policySchema.parse(value)
  const problems: string[] = []
  const seen = new Set<string>()

  for (const script of policy.scripts) {
    if (seen.has(script.id)) problems.push(`Duplicate UAT script: ${script.id}`)
    seen.add(script.id)
    const expectedRole = OPERATIONAL_UAT_SCRIPTS[script.id as keyof typeof OPERATIONAL_UAT_SCRIPTS]
    if (script.role !== expectedRole) problems.push(`${script.id} must belong to ${expectedRole}`)
  }
  for (const scriptId of Object.keys(OPERATIONAL_UAT_SCRIPTS)) {
    if (!seen.has(scriptId)) problems.push(`Missing required UAT script: ${scriptId}`)
  }
  if (problems.length) throw new Error(`Operational UAT policy is invalid:\n- ${problems.join('\n- ')}`)
  return policy
}

export function operationalUatCriteriaDigest(policyValue: unknown) {
  const policy = validateOperationalUatPolicy(policyValue)
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex')
}

export function operationalUatApprovalPayloadDigest(
  evidence: Pick<
    OperationalUatEvidence,
    | 'schemaVersion'
    | 'requirementId'
    | 'status'
    | 'release'
    | 'run'
    | 'participants'
    | 'artifacts'
    | 'results'
    | 'defects'
    | 'trafficDecision'
  >,
  criteriaDigest: string
) {
  const payload = {
    schemaVersion: evidence.schemaVersion,
    requirementId: evidence.requirementId,
    status: evidence.status,
    criteriaDigest,
    release: evidence.release,
    run: evidence.run,
    participants: [...evidence.participants].sort((left, right) => left.id.localeCompare(right.id)),
    artifacts: evidence.artifacts
      .filter((artifact) => artifact.kind !== 'approval-record')
      .sort((left, right) => left.id.localeCompare(right.id)),
    results: [...evidence.results].sort((left, right) => left.scriptId.localeCompare(right.scriptId)),
    defects: [...evidence.defects].sort((left, right) => left.id.localeCompare(right.id)),
    trafficProposal: {
      decision: evidence.trafficDecision.decision,
      currentPercent: evidence.trafficDecision.currentPercent,
      targetPercent: evidence.trafficDecision.targetPercent,
      releaseManagerId: evidence.trafficDecision.releaseManagerId
    }
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function validateOperationalUatEvidence(
  value: unknown,
  policyValue: unknown,
  expectedCommit?: string,
  expectedEnvironmentUrl?: string,
  productionUrl?: string
) {
  const policy = validateOperationalUatPolicy(policyValue)
  const evidence = evidenceSchema.parse(value)
  const criteriaDigest = operationalUatCriteriaDigest(policy)
  const approvalPayloadDigest = operationalUatApprovalPayloadDigest(evidence, criteriaDigest)
  const problems: string[] = []
  const participants = new Map<string, Array<(typeof OPERATIONAL_UAT_PARTICIPANT_ROLES)[number]>>()
  const artifactIds = new Set<string>()
  const resultIds = new Set<string>()
  const defectIds = new Set<string>()
  const signoffRoles = new Set<string>()

  const environmentOrigin = operationalUatStagingOrigin(evidence.release.environmentUrl, productionUrl)
  if (expectedEnvironmentUrl) {
    const expectedOrigin = operationalUatStagingOrigin(expectedEnvironmentUrl, productionUrl)
    if (environmentOrigin !== expectedOrigin) {
      problems.push(`Evidence origin ${environmentOrigin} does not match expected origin ${expectedOrigin}`)
    }
  }
  if (expectedCommit && evidence.release.commitSha.toLowerCase() !== expectedCommit.toLowerCase()) {
    problems.push(`Evidence commit ${evidence.release.commitSha} does not match expected commit ${expectedCommit}`)
  }

  for (const participant of evidence.participants) {
    if (participants.has(participant.id)) problems.push(`Duplicate participant: ${participant.id}`)
    if (new Set(participant.roles).size !== participant.roles.length) {
      problems.push(`Duplicate role for participant: ${participant.id}`)
    }
    participants.set(participant.id, participant.roles)
  }
  for (const role of REQUIRED_UAT_PARTICIPANT_ROLES) {
    if (![...participants.values()].some((roles) => roles.includes(role))) {
      problems.push(`Missing participant for role: ${role}`)
    }
  }

  for (const artifact of evidence.artifacts) {
    if (artifactIds.has(artifact.id)) problems.push(`Duplicate artifact: ${artifact.id}`)
    artifactIds.add(artifact.id)
    if (artifact.storage === 'repository') {
      if (artifact.uri.startsWith('/') || artifact.uri.split('/').includes('..')) {
        problems.push(`Repository artifact path is unsafe: ${artifact.id}`)
      }
    } else {
      try {
        const externalUrl = new URL(artifact.uri)
        if (
          externalUrl.protocol !== 'https:' ||
          externalUrl.username ||
          externalUrl.password ||
          externalUrl.search ||
          externalUrl.hash
        ) {
          problems.push(`External artifact must use a credential-free HTTPS URI: ${artifact.id}`)
        }
      } catch {
        problems.push(`External artifact must use a credential-free HTTPS URI: ${artifact.id}`)
      }
    }
  }
  const preflightArtifacts = evidence.artifacts.filter((artifact) => artifact.kind === 'staging-preflight')
  if (preflightArtifacts.length !== 1) problems.push('Evidence must contain exactly one staging-preflight artifact')
  else if (preflightArtifacts[0]!.storage !== 'repository') {
    problems.push('Staging preflight must be a repository artifact')
  }
  if (
    evidence.artifacts.some((artifact) => artifact.kind === 'inventory-evidence' && artifact.storage !== 'repository')
  ) {
    problems.push('Inventory evidence must be stored as a repository artifact')
  }

  for (const result of evidence.results) {
    if (resultIds.has(result.scriptId)) problems.push(`Duplicate result for script: ${result.scriptId}`)
    resultIds.add(result.scriptId)
    const expectedRole = OPERATIONAL_UAT_SCRIPTS[result.scriptId as keyof typeof OPERATIONAL_UAT_SCRIPTS]
    if (!participants.get(result.testerId)?.includes(expectedRole)) {
      problems.push(`${result.scriptId} tester ${result.testerId} is not a ${expectedRole} participant`)
    }
    if (!participants.get(result.executorId)?.includes('application_operator')) {
      problems.push(`${result.scriptId} executor ${result.executorId} is not an application operator`)
    }
    if (result.testerId === result.executorId) {
      problems.push(`${result.scriptId} tester and executor must be different people`)
    }
    if (result.result !== 'pass') problems.push(`${result.scriptId} is ${result.result}`)
    if (result.result !== 'pass' && result.defectIds.length === 0) {
      problems.push(`${result.scriptId} ${result.result} result lacks a defect`)
    }
    if (new Set(result.artifactIds).size !== result.artifactIds.length) {
      problems.push(`${result.scriptId} contains duplicate artifact references`)
    }
    if (new Set(result.defectIds).size !== result.defectIds.length) {
      problems.push(`${result.scriptId} contains duplicate defect references`)
    }
    for (const artifactId of result.artifactIds) {
      if (!artifactIds.has(artifactId)) problems.push(`${result.scriptId} references unknown artifact: ${artifactId}`)
    }
  }
  for (const scriptId of Object.keys(OPERATIONAL_UAT_SCRIPTS)) {
    if (!resultIds.has(scriptId)) problems.push(`Missing UAT result: ${scriptId}`)
  }
  for (const [scriptId, minimumArtifacts] of [
    ['UAT-WH-001', 1],
    ['UAT-WH-003', 3]
  ] as const) {
    const result = evidence.results.find((candidate) => candidate.scriptId === scriptId)
    const inventoryArtifacts = result?.artifactIds.filter(
      (artifactId) => evidence.artifacts.find((artifact) => artifact.id === artifactId)?.kind === 'inventory-evidence'
    )
    if (!inventoryArtifacts || inventoryArtifacts.length < minimumArtifacts) {
      problems.push(`${scriptId} requires at least ${minimumArtifacts} inventory-evidence artifact(s)`)
    }
  }

  for (const defect of evidence.defects) {
    if (defectIds.has(defect.id)) problems.push(`Duplicate defect: ${defect.id}`)
    defectIds.add(defect.id)
    if (!participants.get(defect.ownerId)?.includes('defect_owner')) {
      problems.push(`Defect ${defect.id} owner ${defect.ownerId} is not a declared defect owner`)
    }
    if (policy.blockingSeverities.some((severity) => severity === defect.severity) && defect.status !== 'resolved') {
      problems.push(`Unresolved ${defect.severity} defect: ${defect.id}`)
    }
    if (defect.status === 'resolved' && defect.retestArtifactIds.length === 0) {
      problems.push(`Resolved defect ${defect.id} lacks retest evidence`)
    }
    if (defect.status === 'resolved' && !defect.resolvedAt) {
      problems.push(`Resolved defect ${defect.id} lacks a resolution timestamp`)
    }
    if (defect.status !== 'resolved' && defect.resolvedAt) {
      problems.push(`Unresolved defect ${defect.id} cannot have a resolution timestamp`)
    }
    if (new Set(defect.scriptIds).size !== defect.scriptIds.length) {
      problems.push(`Defect ${defect.id} contains duplicate script references`)
    }
    if (new Set(defect.retestArtifactIds).size !== defect.retestArtifactIds.length) {
      problems.push(`Defect ${defect.id} contains duplicate retest references`)
    }
    for (const artifactId of defect.retestArtifactIds) {
      const artifact = evidence.artifacts.find((candidate) => candidate.id === artifactId)
      if (!artifact) problems.push(`Defect ${defect.id} references unknown artifact: ${artifactId}`)
      else if (artifact.kind !== 'retest') problems.push(`Defect ${defect.id} retest evidence must use kind retest`)
      else if (defect.resolvedAt && Date.parse(artifact.recordedAt) < Date.parse(defect.resolvedAt)) {
        problems.push(`Defect ${defect.id} retest evidence predates its resolution`)
      } else if (Date.parse(artifact.recordedAt) > Date.parse(evidence.run.completedAt)) {
        problems.push(`Defect ${defect.id} retest evidence was recorded after UAT completed`)
      }
      if (
        !defect.scriptIds.every((scriptId) =>
          evidence.results.find((candidate) => candidate.scriptId === scriptId)?.artifactIds.includes(artifactId)
        )
      ) {
        problems.push(`Defect ${defect.id} retest evidence must be attached to every affected result`)
      }
    }
  }
  for (const result of evidence.results) {
    for (const defectId of result.defectIds) {
      const defect = evidence.defects.find((candidate) => candidate.id === defectId)
      if (!defect) problems.push(`${result.scriptId} references unknown defect: ${defectId}`)
      else if (!defect.scriptIds.includes(result.scriptId)) {
        problems.push(`${result.scriptId} references defect ${defectId} assigned to another script`)
      }
    }
  }
  for (const defect of evidence.defects) {
    for (const scriptId of defect.scriptIds) {
      const result = evidence.results.find((candidate) => candidate.scriptId === scriptId)
      if (!result?.defectIds.includes(defect.id)) {
        problems.push(`Defect ${defect.id} is not referenced by result ${scriptId}`)
      }
    }
  }

  const signerIds = new Set<string>()
  const approvalArtifactIds = new Set<string>()
  for (const signoff of evidence.signoffs) {
    if (signoffRoles.has(signoff.role)) problems.push(`Duplicate signoff for role: ${signoff.role}`)
    signoffRoles.add(signoff.role)
    if (signerIds.has(signoff.signerId)) problems.push(`Signer cannot approve multiple roles: ${signoff.signerId}`)
    signerIds.add(signoff.signerId)
    if (approvalArtifactIds.has(signoff.approvalArtifactId)) {
      problems.push(`Approval record cannot sign multiple roles: ${signoff.approvalArtifactId}`)
    }
    approvalArtifactIds.add(signoff.approvalArtifactId)
    if (!participants.get(signoff.signerId)?.includes(signoff.role)) {
      problems.push(`${signoff.role} signoff does not match participant ${signoff.signerId}`)
    }
    if (signoff.criteriaDigest !== criteriaDigest) problems.push(`${signoff.role} signed a different criteria digest`)
    if (signoff.approvalPayloadDigest !== approvalPayloadDigest) {
      problems.push(`${signoff.role} signed a different UAT approval payload`)
    }
    const approvalArtifact = evidence.artifacts.find((artifact) => artifact.id === signoff.approvalArtifactId)
    if (!approvalArtifact) problems.push(`${signoff.role} signoff references unknown approval artifact`)
    else if (approvalArtifact.kind !== 'approval-record') {
      problems.push(`${signoff.role} signoff artifact must be an approval-record`)
    } else if (approvalArtifact.storage !== 'external') {
      problems.push(`${signoff.role} approval record must be stored externally`)
    } else {
      try {
        const approvalUrl = new URL(approvalArtifact.uri)
        if (approvalUrl.protocol !== 'https:' || approvalUrl.username || approvalUrl.password) {
          problems.push(`${signoff.role} approval record must use a credential-free HTTPS URI`)
        }
      } catch {
        problems.push(`${signoff.role} approval record must use a credential-free HTTPS URI`)
      }
    }
    if (Date.parse(signoff.signedAt) < Date.parse(evidence.run.completedAt)) {
      problems.push(`${signoff.role} signed before UAT completed`)
    }
  }
  for (const role of OPERATIONAL_UAT_SIGNOFF_ROLES) {
    if (!signoffRoles.has(role)) problems.push(`Missing signoff for role: ${role}`)
  }

  const releaseManager = evidence.participants.find(
    (participant) => participant.id === evidence.trafficDecision.releaseManagerId
  )
  if (!releaseManager?.roles.includes('release_manager')) {
    problems.push('Traffic decision must be owned by the release manager')
  }
  if (evidence.trafficDecision.targetPercent <= evidence.trafficDecision.currentPercent) {
    problems.push('Traffic target must increase the current percentage')
  }
  const releaseManagerSignoff = evidence.signoffs.find((signoff) => signoff.role === 'release_manager')
  if (releaseManagerSignoff?.signerId !== evidence.trafficDecision.releaseManagerId) {
    problems.push('Traffic decision and release-manager signoff do not match')
  }
  const lastSignoff = Math.max(...evidence.signoffs.map((signoff) => Date.parse(signoff.signedAt)))
  if (Date.parse(evidence.trafficDecision.approvedAt) < lastSignoff) {
    problems.push('Traffic decision predates required signoffs')
  }
  if (Date.parse(evidence.trafficDecision.validUntil) <= Date.parse(evidence.trafficDecision.approvedAt)) {
    problems.push('Traffic approval must expire after it is issued')
  }
  if (Date.parse(evidence.trafficDecision.validUntil) - Date.parse(evidence.run.completedAt) > 7 * 24 * 60 * 60_000) {
    problems.push('Traffic approval cannot remain valid for more than seven days after UAT')
  }
  if (Date.parse(evidence.release.deployedAt) > Date.parse(evidence.run.startedAt)) {
    problems.push('UAT started before the tested commit was deployed')
  }
  if (Date.parse(evidence.run.startedAt) > Date.parse(evidence.run.completedAt)) {
    problems.push('UAT completed before it started')
  }

  if (problems.length) throw new Error(`Operational UAT evidence is not acceptable:\n- ${problems.join('\n- ')}`)
  return { evidence, policy, criteriaDigest, approvalPayloadDigest }
}

export function validateOperationalUatPreflight(
  value: unknown,
  expectedCommit: string,
  expectedEnvironmentUrl: string
) {
  const preflight = preflightSchema.parse(value)
  const probeIds = new Set(preflight.probes.map((probe) => probe.id))
  if (probeIds.size !== preflightProbeIds.length || preflightProbeIds.some((id) => !probeIds.has(id))) {
    throw new Error('Operational UAT preflight does not contain every required probe exactly once')
  }
  if (preflight.probes.some((probe) => probe.path !== preflightProbePaths[probe.id])) {
    throw new Error('Operational UAT preflight probe path does not match its governed ID')
  }
  if (preflight.expectedCommit.toLowerCase() !== expectedCommit.toLowerCase()) {
    throw new Error('Operational UAT preflight commit does not match the evidence release')
  }
  if (operationalUatStagingOrigin(preflight.environmentUrl) !== operationalUatStagingOrigin(expectedEnvironmentUrl)) {
    throw new Error('Operational UAT preflight origin does not match the evidence release')
  }
  return preflight
}

export async function verifyOperationalUatRepositoryArtifacts(
  evidence: OperationalUatEvidence,
  repositoryRoot = process.cwd()
) {
  const root = resolve(repositoryRoot)
  let verified = 0
  const inventoryEvidenceByArtifact = new Map<string, ReturnType<typeof validateOperationalUatInventoryArtifact>>()
  for (const artifact of evidence.artifacts.filter((candidate) => candidate.storage === 'repository')) {
    const path = await realpath(resolve(root, artifact.uri))
    if (!path.startsWith(`${root}/`)) throw new Error(`Repository artifact escapes the repository: ${artifact.id}`)
    const contents = await readFile(path)
    const digest = createHash('sha256').update(contents).digest('hex')
    if (digest !== artifact.sha256.toLowerCase()) throw new Error(`Artifact hash does not match: ${artifact.id}`)
    if (artifact.kind === 'staging-preflight') {
      const preflight = validateOperationalUatPreflight(
        JSON.parse(contents.toString('utf8')),
        evidence.release.commitSha,
        evidence.release.environmentUrl
      )
      if (
        Date.parse(preflight.generatedAt) < Date.parse(evidence.release.deployedAt) ||
        Date.parse(preflight.generatedAt) > Date.parse(evidence.run.startedAt)
      ) {
        throw new Error('Operational UAT preflight must run after deployment and before the UAT session')
      }
      if (artifact.recordedAt !== preflight.generatedAt) {
        throw new Error('Operational UAT preflight artifact timestamp does not match its contents')
      }
    } else if (artifact.kind === 'inventory-evidence') {
      const inventoryEvidence = validateOperationalUatInventoryArtifact(
        JSON.parse(contents.toString('utf8')),
        evidence.release.commitSha
      )
      inventoryEvidenceByArtifact.set(artifact.id, inventoryEvidence)
      if (artifact.recordedAt !== inventoryEvidence.generatedAt) {
        throw new Error(`Inventory evidence artifact timestamp does not match its contents: ${artifact.id}`)
      }
      if (
        Date.parse(inventoryEvidence.generatedAt) < Date.parse(evidence.run.startedAt) ||
        Date.parse(inventoryEvidence.generatedAt) > Date.parse(evidence.run.completedAt)
      ) {
        throw new Error(`Inventory evidence must be recorded during the UAT session: ${artifact.id}`)
      }
    }
    verified += 1
  }
  const warehouseInventory = (scriptId: 'UAT-WH-001' | 'UAT-WH-003') => {
    const result = evidence.results.find((candidate) => candidate.scriptId === scriptId)
    return (result?.artifactIds ?? []).flatMap((artifactId) => {
      const inventoryArtifact = inventoryEvidenceByArtifact.get(artifactId)
      return inventoryArtifact ? [inventoryArtifact] : []
    })
  }
  const warehouseBaseline = warehouseInventory('UAT-WH-001')
  const warehouseCases = warehouseInventory('UAT-WH-003')
  if (warehouseBaseline.length !== 1 || warehouseBaseline[0]?.case !== 'baseline') {
    throw new Error('UAT-WH-001 requires exactly one baseline inventory evidence artifact')
  }
  if (
    warehouseCases.length !== 3 ||
    new Set(warehouseCases.map((item) => item.case)).size !== 3 ||
    !['pickup', 'cancellation', 'return'].every((caseId) => warehouseCases.some((item) => item.case === caseId))
  ) {
    throw new Error('UAT-WH-003 requires pickup, cancellation and return inventory evidence')
  }
  const warehouseOrderNumbers = [...warehouseBaseline, ...warehouseCases].map((item) => item.orderNumber)
  if (new Set(warehouseOrderNumbers).size !== warehouseOrderNumbers.length) {
    throw new Error('Warehouse inventory evidence must use a distinct order for every case')
  }
  return verified
}
