import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOperationalUatInventoryEvidence } from '../../scripts/lib/operational-uat-inventory'
import {
  operationalUatApprovalPayloadDigest,
  operationalUatCriteriaDigest,
  operationalUatStagingOrigin,
  validateOperationalUatEvidence,
  validateOperationalUatPolicy,
  verifyOperationalUatRepositoryArtifacts
} from '../../scripts/lib/operational-uat'

const policy = JSON.parse(readFileSync(resolve('docs/testing/operational-uat-policy.json'), 'utf8'))
const hash = 'a'.repeat(64)
const commit = 'b'.repeat(40)

function inventoryEvidence(caseId: 'baseline' | 'pickup' | 'cancellation' | 'return', orderNumber: string) {
  const committed = caseId === 'baseline' || caseId === 'pickup' ? 2 : 0
  const movementType =
    caseId === 'cancellation'
      ? 'release'
      : caseId === 'return'
        ? 'return'
        : caseId === 'pickup'
          ? 'allocate'
          : 'reserve'
  return buildOperationalUatInventoryEvidence(
    {
      publicNumber: orderNumber,
      expectedCommit: commit,
      appEnv: 'staging',
      appVersion: commit,
      caseId,
      generatedAt: '2026-08-18T11:30:00.000Z'
    },
    {
      order: {
        publicNumber: orderNumber,
        orderStatus: 'confirmed',
        paymentStatus: 'captured',
        inventoryStatus: caseId === 'cancellation' ? 'released' : caseId === 'return' ? 'returned' : 'allocated',
        fulfillmentStatus: caseId === 'pickup' ? 'delivered' : caseId === 'return' ? 'returned' : 'pending',
        shippingMethod: caseId === 'pickup' ? 'recogida' : 'envio',
        correlationId: '11111111-1111-4111-8111-111111111111',
        lineCount: 1
      },
      lines: [{ sku: 'UAT-SKU', quantity: 2, variantId: 'variant-1', currentSku: 'UAT-SKU' }],
      balances: [
        {
          sku: 'UAT-SKU',
          locationCode: 'UAT-WH',
          physicalQuantity: 18,
          blockedQuantity: 0,
          safetyStock: 0,
          activeReservedQuantity: caseId === 'baseline' ? 2 : 0,
          allocatedQuantity: caseId === 'pickup' ? 2 : 0,
          orderCommittedQuantity: committed,
          ledgerPhysicalQuantity: 18,
          ledgerReservedDelta: committed,
          version: 1
        }
      ],
      movements: [
        {
          sku: 'UAT-SKU',
          locationCode: 'UAT-WH',
          movementType,
          quantity: caseId === 'return' ? 2 : -2,
          physicalDelta: caseId === 'return' ? 2 : caseId === 'pickup' ? -2 : 0,
          reservedDelta: caseId === 'baseline' ? 2 : caseId === 'pickup' || caseId === 'cancellation' ? -2 : 0,
          count: 1
        }
      ],
      audit: [
        {
          source: 'order_event',
          eventType: 'uat.transition',
          resourceType: 'order',
          resourceReference: orderNumber,
          correlationId: '11111111-1111-4111-8111-111111111111',
          createdAt: '2026-08-18T11:20:00.000Z',
          reasonDigest: hash,
          reasonLength: 8
        }
      ]
    }
  )
}

function validEvidence() {
  const criteriaDigest = operationalUatCriteriaDigest(policy)
  const testerByRole = {
    warehouse: 'warehouse.tester',
    administration: 'administration.tester',
    support: 'support.tester'
  } as const
  const signers = [
    { id: testerByRole.warehouse, roles: ['warehouse'] },
    { id: testerByRole.administration, roles: ['administration', 'defect_owner'] },
    { id: testerByRole.support, roles: ['support', 'defect_owner'] },
    { id: 'release.manager', roles: ['release_manager'] }
  ]
  const participants = [...signers, { id: 'application.operator', roles: ['application_operator'] }]
  const artifacts = [
    {
      id: 'run-notes',
      kind: 'notes',
      storage: 'external',
      uri: 'https://evidence.neteco.es/uat/run-notes',
      sha256: hash,
      recordedAt: '2026-08-18T12:00:00.000Z'
    },
    {
      id: 'staging-preflight',
      kind: 'staging-preflight',
      storage: 'repository',
      uri: 'evidence/uat/preflight.json',
      sha256: hash,
      recordedAt: '2026-08-18T08:30:00.000Z'
    },
    ...['wh001', 'wh003-a', 'wh003-b', 'wh003-c'].map((caseId) => ({
      id: `inventory-${caseId}`,
      kind: 'inventory-evidence',
      storage: 'repository',
      uri: `evidence/uat/inventory-${caseId}.json`,
      sha256: hash,
      recordedAt: '2026-08-18T11:30:00.000Z'
    })),
    ...signers.map((participant) => ({
      id: `approval-${participant.roles[0]}`,
      kind: 'approval-record',
      storage: 'external',
      uri: `https://approvals.neteco.es/uat/${participant.roles[0]}`,
      sha256: hash,
      recordedAt: '2026-08-18T13:00:00.000Z'
    }))
  ]
  const unsignedEvidence = {
    schemaVersion: 1,
    requirementId: 'TST-040',
    status: 'final',
    release: {
      id: 'beta-2026.08.18',
      commitSha: commit,
      environment: 'staging',
      environmentUrl: 'https://staging.neteco.es',
      deployedAt: '2026-08-18T08:00:00.000Z'
    },
    run: {
      startedAt: '2026-08-18T09:00:00.000Z',
      completedAt: '2026-08-18T12:00:00.000Z'
    },
    participants,
    artifacts,
    results: policy.scripts.map((script: { id: string; role: keyof typeof testerByRole }) => {
      const inventoryArtifactIds =
        script.id === 'UAT-WH-001'
          ? ['inventory-wh001']
          : script.id === 'UAT-WH-003'
            ? ['inventory-wh003-a', 'inventory-wh003-b', 'inventory-wh003-c']
            : []
      return {
        scriptId: script.id,
        testerId: testerByRole[script.role],
        executorId: 'application.operator',
        result: 'pass',
        artifactIds: ['run-notes', ...inventoryArtifactIds],
        defectIds: [],
        notes: 'Resultado contrastado con el estado final saneado.'
      }
    }),
    defects: [],
    trafficDecision: {
      decision: 'approved',
      currentPercent: 10,
      targetPercent: 25,
      releaseManagerId: 'release.manager',
      approvedAt: '2026-08-18T14:00:00.000Z',
      validUntil: '2026-08-24T12:00:00.000Z'
    }
  }
  const approvalPayloadDigest = operationalUatApprovalPayloadDigest(
    unsignedEvidence as Parameters<typeof operationalUatApprovalPayloadDigest>[0],
    criteriaDigest
  )
  return {
    ...unsignedEvidence,
    signoffs: signers.map((participant) => ({
      role: participant.roles[0],
      signerId: participant.id,
      decision: 'approved',
      signedAt: '2026-08-18T13:00:00.000Z',
      criteriaDigest,
      approvalPayloadDigest,
      approvalArtifactId: `approval-${participant.roles[0]}`
    }))
  }
}

function resignEvidence(evidence: ReturnType<typeof validEvidence>) {
  const approvalPayloadDigest = operationalUatApprovalPayloadDigest(evidence, operationalUatCriteriaDigest(policy))
  for (const signoff of evidence.signoffs) signoff.approvalPayloadDigest = approvalPayloadDigest
}

describe('operational UAT gate', () => {
  it('locks the nine scripts to the expected operational roles', () => {
    const parsed = validateOperationalUatPolicy(policy)
    expect(parsed.scripts).toHaveLength(9)
    expect(parsed.scripts.filter((script) => script.role === 'warehouse')).toHaveLength(3)
    expect(parsed.scripts.filter((script) => script.role === 'administration')).toHaveLength(3)
    expect(parsed.scripts.filter((script) => script.role === 'support')).toHaveLength(3)
    expect(operationalUatCriteriaDigest(parsed)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts complete signed evidence before increasing traffic', () => {
    const result = validateOperationalUatEvidence(
      validEvidence(),
      policy,
      commit,
      'https://staging.neteco.es/health',
      'https://neteco.es'
    )
    expect(result.evidence.results).toHaveLength(9)
    expect(result.evidence.trafficDecision).toMatchObject({ currentPercent: 10, targetPercent: 25 })
  })

  it('rejects missing scripts and scripts assigned to another role', () => {
    const missing = structuredClone(policy)
    missing.scripts.pop()
    expect(() => validateOperationalUatPolicy(missing)).toThrow()

    const wrongRole = structuredClone(policy)
    wrongRole.scripts[0].role = 'support'
    expect(() => validateOperationalUatPolicy(wrongRole)).toThrow(/must belong to warehouse/)
  })

  it('binds the run to the expected commit and real staging origin', () => {
    const evidence = validEvidence()
    evidence.release.environmentUrl = 'http://localhost:3100'
    expect(() => validateOperationalUatEvidence(evidence, policy, 'c'.repeat(40), 'https://staging.neteco.es')).toThrow(
      /real credential-free staging HTTPS URL/
    )
    expect(() => operationalUatStagingOrigin('https://staging.neteco.invalid')).toThrow()
    expect(() => operationalUatStagingOrigin('https://user:secret@staging.neteco.es')).toThrow()
    expect(() => operationalUatStagingOrigin('https://10.0.0.1')).toThrow()
    expect(() => operationalUatStagingOrigin('https://test')).toThrow()
    expect(() => operationalUatStagingOrigin('https://neteco.es', 'https://neteco.es')).toThrow(
      /differ from production/
    )
  })

  it('requires passing results executed by the matching operational role', () => {
    const evidence = validEvidence()
    evidence.results[0]!.testerId = 'support.tester'
    evidence.results[0]!.executorId = 'support.tester'
    evidence.results[1]!.result = 'blocked'
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /is not a warehouse participant|is not an application operator|is blocked|lacks a defect/
    )
  })

  it('keeps the business tester separate from the application operator', () => {
    const evidence = validEvidence()
    evidence.participants
      .find((participant) => participant.id === 'administration.tester')!
      .roles.push('application_operator')
    const result = evidence.results.find((candidate) => candidate.scriptId === 'UAT-ADM-001')!
    result.executorId = result.testerId
    resignEvidence(evidence)
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /tester and executor must be different people/
    )
  })

  it('blocks unresolved P0 and P1 and requires retest evidence after resolution', () => {
    const evidence = validEvidence()
    evidence.defects = [
      {
        id: 'UAT-DEF-001',
        severity: 'P1',
        status: 'open',
        ownerId: 'administration.tester',
        scriptIds: ['UAT-ADM-001'],
        resolvedAt: null,
        retestArtifactIds: ['run-notes']
      },
      {
        id: 'UAT-DEF-002',
        severity: 'P2',
        status: 'resolved',
        ownerId: 'support.tester',
        scriptIds: ['UAT-SUP-001'],
        resolvedAt: '2026-08-18T11:00:00.000Z',
        retestArtifactIds: []
      }
    ]
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /Unresolved P1 defect|retest evidence must use kind retest/
    )
  })

  it('requires authenticated approvals over the current criteria', () => {
    const evidence = validEvidence()
    evidence.signoffs[0]!.criteriaDigest = 'c'.repeat(64)
    evidence.artifacts.find((artifact) => artifact.id === 'approval-support')!.kind = 'notes'
    evidence.artifacts.find((artifact) => artifact.id === 'approval-administration')!.uri =
      'http://approvals.neteco.es/uat/administration'
    evidence.signoffs[3]!.approvalArtifactId = evidence.signoffs[0]!.approvalArtifactId
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /signed a different criteria digest|must be an approval-record|credential-free HTTPS URI|cannot sign multiple roles/
    )
  })

  it('binds approvals to the release results defects and traffic decision', () => {
    const evidence = validEvidence()
    evidence.trafficDecision.targetPercent = 50
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /signed a different UAT approval payload/
    )
  })

  it('orders deployment, execution, signoffs and the traffic increase', () => {
    const evidence = validEvidence()
    evidence.release.deployedAt = '2026-08-18T10:00:00.000Z'
    evidence.run.completedAt = '2026-08-18T08:30:00.000Z'
    evidence.trafficDecision.targetPercent = 5
    evidence.trafficDecision.approvedAt = '2026-08-18T12:30:00.000Z'
    expect(() => validateOperationalUatEvidence(evidence, policy, commit)).toThrow(
      /started before|completed before|must increase|predates required signoffs/
    )
  })

  it('recalculates repository artifact hashes and binds the preflight to release and origin', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'neteco-uat-'))
    try {
      const preflight = {
        schemaVersion: 1,
        requirementId: 'TST-040',
        kind: 'staging-preflight',
        generatedAt: '2026-08-18T08:30:00.000Z',
        environmentUrl: 'https://staging.neteco.es',
        expectedCommit: commit,
        status: 'pass',
        probes: [
          ['live-version', '/api/health/live'],
          ['ready-dependencies', '/api/health/ready'],
          ['storefront-noindex', '/'],
          ['catalog', '/api/products?limit=1'],
          ['robots', '/robots.txt']
        ].map(([id, path]) => ({ id, path, status: 200, durationMs: 10, pass: true, detail: 'ok' }))
      }
      const contents = `${JSON.stringify(preflight, null, 2)}\n`
      await writeFile(join(temporary, 'preflight.json'), contents, 'utf8')
      const evidenceValue = validEvidence()
      const artifact = evidenceValue.artifacts.find((item) => item.id === 'staging-preflight')!
      artifact.uri = 'preflight.json'
      artifact.sha256 = createHash('sha256').update(contents).digest('hex')
      for (const inventoryArtifact of evidenceValue.artifacts.filter((item) => item.kind === 'inventory-evidence')) {
        const caseId = inventoryArtifact.id.endsWith('wh001')
          ? 'baseline'
          : inventoryArtifact.id.endsWith('a')
            ? 'pickup'
            : inventoryArtifact.id.endsWith('b')
              ? 'cancellation'
              : 'return'
        const inventory = inventoryEvidence(caseId, `NE${inventoryArtifact.id.replaceAll('-', '').toUpperCase()}`)
        const inventoryContents = `${JSON.stringify(inventory, null, 2)}\n`
        inventoryArtifact.uri = `${inventoryArtifact.id}.json`
        inventoryArtifact.sha256 = createHash('sha256').update(inventoryContents).digest('hex')
        await writeFile(join(temporary, inventoryArtifact.uri), inventoryContents, 'utf8')
      }
      resignEvidence(evidenceValue)
      const { evidence } = validateOperationalUatEvidence(evidenceValue, policy, commit)
      await expect(verifyOperationalUatRepositoryArtifacts(evidence, temporary)).resolves.toBe(5)
      const duplicateCaseArtifact = evidence.artifacts.find((item) => item.id === 'inventory-wh003-b')!
      const duplicateCaseContents = `${JSON.stringify(inventoryEvidence('pickup', 'NEDUPLICATECASE'), null, 2)}\n`
      await writeFile(join(temporary, duplicateCaseArtifact.uri), duplicateCaseContents, 'utf8')
      duplicateCaseArtifact.sha256 = createHash('sha256').update(duplicateCaseContents).digest('hex')
      await expect(verifyOperationalUatRepositoryArtifacts(evidence, temporary)).rejects.toThrow(
        /requires pickup, cancellation and return/
      )
      const duplicateOrderContents = `${JSON.stringify(
        inventoryEvidence('cancellation', 'NEINVENTORYWH003A'),
        null,
        2
      )}\n`
      await writeFile(join(temporary, duplicateCaseArtifact.uri), duplicateOrderContents, 'utf8')
      duplicateCaseArtifact.sha256 = createHash('sha256').update(duplicateOrderContents).digest('hex')
      await expect(verifyOperationalUatRepositoryArtifacts(evidence, temporary)).rejects.toThrow(
        /distinct order for every case/
      )
      evidence.artifacts.find((item) => item.id === 'staging-preflight')!.sha256 = hash
      await expect(verifyOperationalUatRepositoryArtifacts(evidence, temporary)).rejects.toThrow(
        /Artifact hash does not match/
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
