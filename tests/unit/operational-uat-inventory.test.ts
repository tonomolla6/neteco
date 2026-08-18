import { describe, expect, it } from 'vitest'
import {
  buildOperationalUatInventoryEvidence,
  inventoryReasonDigest,
  type OperationalUatInventorySnapshot,
  validateOperationalUatInventoryArtifact,
  validateOperationalUatInventoryContext
} from '../../scripts/lib/operational-uat-inventory'

const commit = 'a'.repeat(40)
const correlationId = '11111111-1111-4111-8111-111111111111'

function context(overrides: Partial<Parameters<typeof validateOperationalUatInventoryContext>[0]> = {}) {
  return {
    publicNumber: 'NEABC123456',
    expectedCommit: commit,
    appEnv: 'staging',
    appVersion: commit,
    caseId: 'baseline',
    generatedAt: '2026-08-18T12:00:00.000Z',
    ...overrides
  }
}

function snapshot(overrides: Partial<OperationalUatInventorySnapshot> = {}): OperationalUatInventorySnapshot {
  return {
    order: {
      publicNumber: 'NEABC123456',
      orderStatus: 'confirmed',
      paymentStatus: 'captured',
      inventoryStatus: 'allocated',
      fulfillmentStatus: 'pending',
      shippingMethod: 'envio',
      correlationId,
      lineCount: 1
    },
    lines: [{ sku: 'UAT-SKU-001', quantity: 2, variantId: 'variant-1', currentSku: 'UAT-SKU-001' }],
    balances: [
      {
        sku: 'UAT-SKU-001',
        locationCode: 'ONT-WH-01',
        physicalQuantity: 18,
        blockedQuantity: 1,
        safetyStock: 2,
        activeReservedQuantity: 0,
        allocatedQuantity: 2,
        orderCommittedQuantity: 2,
        ledgerPhysicalQuantity: 18,
        ledgerReservedDelta: 0,
        version: 3
      }
    ],
    movements: [
      {
        sku: 'UAT-SKU-001',
        locationCode: 'ONT-WH-01',
        movementType: 'allocate',
        quantity: -2,
        physicalDelta: -2,
        reservedDelta: -2,
        count: 1
      }
    ],
    audit: [
      {
        source: 'order_event',
        eventType: 'admin.order.transitioned',
        resourceType: 'order',
        resourceReference: 'NEABC123456',
        correlationId,
        createdAt: '2026-08-18T11:59:00.000Z',
        reasonDigest: inventoryReasonDigest('UAT preparación'),
        reasonLength: 14
      }
    ],
    ...overrides
  }
}

describe('operational UAT inventory evidence', () => {
  it('requires staging, matching immutable commit and a public order reference', () => {
    expect(validateOperationalUatInventoryContext(context()).appEnv).toBe('staging')
    expect(() => validateOperationalUatInventoryContext(context({ appEnv: 'production' }))).toThrow(
      /APP_ENV must be exactly staging/
    )
    expect(() => validateOperationalUatInventoryContext(context({ appVersion: 'b'.repeat(40) }))).toThrow(
      /does not match the expected commit/
    )
    expect(() =>
      validateOperationalUatInventoryContext(context({ publicNumber: '550e8400-e29b-41d4-a716-446655440000' }))
    ).toThrow(/public order number has an invalid format/)
  })

  it('emits a passing, sanitized snapshot with available stock derived read-only', () => {
    const evidence = buildOperationalUatInventoryEvidence(context(), snapshot())
    expect(evidence).toMatchObject({
      kind: 'uat-inventory-evidence',
      requirementId: 'TST-040',
      status: 'pass',
      case: 'baseline',
      expectedCommit: commit,
      orderNumber: 'NEABC123456'
    })
    expect(evidence.balances[0]).toMatchObject({ availableQuantity: 15, physicalQuantity: 18 })
    expect(JSON.stringify(evidence)).not.toContain('UAT preparación')
    expect(evidence.audit[0]).toMatchObject({ reasonDigest: inventoryReasonDigest('UAT preparación') })
  })

  it('fails on negative/inconsistent ledger, reservation or missing movement evidence', () => {
    const broken = snapshot({
      balances: [
        {
          ...snapshot().balances[0]!,
          physicalQuantity: -1,
          ledgerPhysicalQuantity: 17,
          blockedQuantity: 2,
          activeReservedQuantity: 20
        }
      ],
      movements: [],
      audit: []
    })
    const evidence = buildOperationalUatInventoryEvidence(context(), broken)
    expect(evidence.status).toBe('fail')
    expect(evidence.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('physical-nonnegative'),
        expect.stringContaining('blocked-within-physical'),
        expect.stringContaining('ledger-physical'),
        expect.stringContaining('correlated-operational-reason'),
        expect.stringContaining('movement-evidence')
      ])
    )
  })

  it('fails when the order state says allocated but no order commitment is present', () => {
    const evidence = buildOperationalUatInventoryEvidence(
      context(),
      snapshot({ balances: [{ ...snapshot().balances[0]!, orderCommittedQuantity: 0 }] })
    )
    expect(evidence.status).toBe('fail')
    expect(evidence.problems).toContain(
      'order-commitment-state:UAT-SKU-001: inventory=allocated committed=0 expected=2'
    )
  })

  it('recomputes artifact checks and rejects a fabricated pass', () => {
    const evidence = buildOperationalUatInventoryEvidence(context(), snapshot())
    expect(validateOperationalUatInventoryArtifact(evidence, commit).status).toBe('pass')
    evidence.balances[0]!.physicalQuantity = -1
    expect(() => validateOperationalUatInventoryArtifact(evidence, commit)).toThrow(
      /reconciliation does not match its raw inventory snapshot/
    )
  })

  it('validates the final state for each warehouse case', () => {
    const pickup = buildOperationalUatInventoryEvidence(
      context({ caseId: 'pickup' }),
      snapshot({ order: { ...snapshot().order, shippingMethod: 'recogida', fulfillmentStatus: 'delivered' } })
    )
    expect(pickup.status).toBe('pass')
    const wrongReturn = buildOperationalUatInventoryEvidence(context({ caseId: 'return' }), snapshot())
    expect(wrongReturn.status).toBe('fail')
    expect(wrongReturn.problems).toEqual(expect.arrayContaining([expect.stringContaining('return-final-state')]))
  })
})
