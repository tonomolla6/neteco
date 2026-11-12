import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import {
  blockLotExpedition,
  configureVariantLotPolicy,
  evaluateOrderExpeditionEligibility,
  locateLotAffectedCustomers,
  locateLotAffectedStock,
  unblockLotExpedition
} from '../../workers/catalog/catalog-lot-recall'
import { executeProductRecall } from '../../workers/catalog/product-recall'
import { CatalogLotRecallError } from '../../shared/catalog-markets'
import { testUuid } from '../support/deterministic'

const MIGRATION_PATH_106 = 'db/d1/migrations/0106_inventory_lots_costing_forecast.sql'
const MIGRATION_PATH_118 = 'db/d1/migrations/0118_recall_market_messaging.sql'
const MIGRATION_PATH_120 = 'db/d1/migrations/0120_market_catalog_international_shipping.sql'
const options = { now: () => utc() }

describe('CAT-020: Lotes, caducidad y recall cuando el surtido lo exija', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  const lotId1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const lotId2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const variantId = 'v-1-1'
  let orderId: string
  let warehouseLocation: string

  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite.exec(await readFile(MIGRATION_PATH_106, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_118, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_120, 'utf8'))

    orderId = await f.order({ paid: true, delivered: false })
    warehouseLocation = (
      f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get(variantId) as {
        location_id: string
      }
    ).location_id

    // Seed test lot 1 (active, expires in 60 days)
    f.sqlite
      .prepare(
        `INSERT INTO inventory_lots(id, variant_id, lot_number, location_id, status, expires_at, initial_quantity, available_quantity, version, created_at, updated_at)
         VALUES(?, ?, 'LOT-2026-ALPHA', ?, 'active', ?, 50, 40, 1, ?, ?)`
      )
      .run(lotId1, variantId, warehouseLocation, utc(60 * 86400000), utc(), utc())

    // Seed test lot 2 (active, expires in 2 days - short expiry)
    f.sqlite
      .prepare(
        `INSERT INTO inventory_lots(id, variant_id, lot_number, location_id, status, expires_at, initial_quantity, available_quantity, version, created_at, updated_at)
         VALUES(?, ?, 'LOT-2026-BETA', ?, 'active', ?, 20, 20, 1, ?, ?)`
      )
      .run(lotId2, variantId, warehouseLocation, utc(2 * 86400000), utc(), utc())

    // Allocate 2 units of lot 1 to the order
    f.sqlite
      .prepare(
        `INSERT INTO inventory_lot_allocations(id, lot_id, order_id, order_line_index, customer_id, quantity, correlation_id, created_at)
         VALUES(?, ?, ?, 0, ?, 2, 'seed-alloc', ?)`
      )
      .run(testUuid(), lotId1, orderId, CUSTOMER, utc())
  })

  afterEach(() => {
    f?.sqlite.close()
  })

  it('configures lot tracking requirement and minimum shelf life per variant', async () => {
    const policy = {
      variantId,
      expectedVersion: 0,
      lotTrackingRequired: true,
      shelfLifeDays: 365,
      minShelfLifeDispatchDays: 30,
      quarantineOnExpiry: true
    }

    const commandId = '55555555-5555-4555-8555-555555555555'
    const result = await configureVariantLotPolicy(f.database, CLAIMS, commandId, policy, options)
    expect(result).toMatchObject({
      commandId,
      variantId,
      version: 1
    })

    const row = f.sqlite
      .prepare('SELECT * FROM catalog_lot_tracking_policies WHERE variant_id=?')
      .get(variantId) as Record<string, unknown>
    expect(row).toMatchObject({
      variant_id: variantId,
      lot_tracking_required: 1,
      min_shelf_life_dispatch_days: 30
    })
  })

  it('locates affected stock across warehouse locations for a given lot', async () => {
    const stockReport = await locateLotAffectedStock(f.database, lotId1)
    expect(stockReport).toMatchObject({
      lotId: lotId1,
      lotNumber: 'LOT-2026-ALPHA',
      variantId,
      locationId: warehouseLocation,
      initialQuantity: 50,
      availableQuantity: 40,
      status: 'active'
    })
    expect(stockReport.isExpeditionBlocked).toBe(false)
  })

  it('locates affected customers and orders for a given lot', async () => {
    const customerReport = await locateLotAffectedCustomers(f.database, lotId1)
    expect(customerReport.lotId).toBe(lotId1)
    expect(customerReport.lotNumber).toBe('LOT-2026-ALPHA')
    expect(customerReport.affectedCustomers).toHaveLength(1)
    expect(customerReport.affectedCustomers[0]).toMatchObject({
      orderId,
      lineIndex: 0,
      customerId: CUSTOMER,
      quantity: 2
    })
  })

  it('blocks expedition of a lot and locates affected stock as blocked', async () => {
    const blockCommandId = '66666666-6666-4666-8666-666666666666'
    const blockResult = await blockLotExpedition(
      f.database,
      CLAIMS,
      blockCommandId,
      {
        lotId: lotId1,
        blockReason: 'manual_quarantine',
        evidence: 'chemical-density-deviation'
      },
      options
    )
    expect(blockResult).toMatchObject({
      lotId: lotId1,
      isBlocked: true,
      blockReason: 'manual_quarantine'
    })

    // Now locating affected stock shows expedition is blocked
    const stockReport = await locateLotAffectedStock(f.database, lotId1)
    expect(stockReport.isExpeditionBlocked).toBe(true)
    expect(stockReport.blockReason).toBe('manual_quarantine')

    // Order containing this lot is now blocked for expedition
    const eligibility = await evaluateOrderExpeditionEligibility(f.database, orderId, options)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.blockedLines).toHaveLength(1)
    expect(eligibility.blockedLines[0]).toMatchObject({
      lineIndex: 0,
      lotId: lotId1,
      reason: 'manual_quarantine'
    })
  })

  it('unblocks expedition of a lot after clearance', async () => {
    const blockCommandId = '66666666-6666-4666-8666-666666666666'
    await blockLotExpedition(
      f.database,
      CLAIMS,
      blockCommandId,
      { lotId: lotId1, blockReason: 'manual_quarantine', evidence: 'precautionary-hold' },
      options
    )

    const unblockCommandId = '77777777-7777-4777-8777-777777777777'
    const unblockResult = await unblockLotExpedition(
      f.database,
      CLAIMS,
      unblockCommandId,
      { lotId: lotId1, evidence: 'lab-analysis-cleared' },
      options
    )
    expect(unblockResult.isBlocked).toBe(false)

    const stockReport = await locateLotAffectedStock(f.database, lotId1)
    expect(stockReport.isExpeditionBlocked).toBe(false)
  })

  it('INT-7: unblocking never reactivates a lot that has no active expedition block', async () => {
    // Quarantined by another process (quality hold), not by the expedition block.
    f.sqlite.prepare("UPDATE inventory_lots SET status='quarantined' WHERE id=?").run(lotId1)
    await expect(
      unblockLotExpedition(
        f.database,
        CLAIMS,
        '99999999-9999-4999-8999-999999999999',
        { lotId: lotId1, evidence: 'lab-analysis-cleared' },
        options
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    const row = f.sqlite.prepare('SELECT status FROM inventory_lots WHERE id=?').get(lotId1) as { status: string }
    expect(row.status).toBe('quarantined')
  })

  it('INT-7: re-blocking an already blocked lot is idempotent and never overwrites the first evidence', async () => {
    const commandId = '12121212-1212-4212-8212-121212121212'
    const input = { lotId: lotId1, blockReason: 'manual_quarantine', evidence: 'first-evidence' }
    await blockLotExpedition(f.database, CLAIMS, commandId, input, options)
    await blockLotExpedition(f.database, CLAIMS, commandId, input, options)
    await expect(
      blockLotExpedition(f.database, CLAIMS, commandId, { ...input, evidence: 'other-evidence' }, options)
    ).rejects.toMatchObject({ code: 'conflict' })
    const rows = f.sqlite.prepare('SELECT evidence FROM lot_expedition_blocks WHERE lot_id=?').all(lotId1)
    expect(rows).toEqual([{ evidence: 'first-evidence' }])
  })

  it('blocks expedition when a lot is under active product recall', async () => {
    const recallCommandId = '88888888-8888-4888-8888-888888888888'
    await executeProductRecall(
      f.database,
      CLAIMS,
      lotId1,
      recallCommandId,
      { action: 'open', expectedVersion: 0, evidence: 'ph-anomaly-case' },
      options
    )

    const eligibility = await evaluateOrderExpeditionEligibility(f.database, orderId, options)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.blockedLines[0]?.reason).toBe('lot_recalled')
  })

  it('blocks expedition when an allocated lot is expired or below minimum dispatch shelf life', async () => {
    // Configure variant lot policy: requires 10 days minimum shelf life to dispatch
    await configureVariantLotPolicy(
      f.database,
      CLAIMS,
      '55555555-5555-4555-8555-555555555555',
      {
        variantId,
        expectedVersion: 0,
        lotTrackingRequired: true,
        shelfLifeDays: 365,
        minShelfLifeDispatchDays: 10,
        quarantineOnExpiry: true
      },
      options
    )

    // Lot 2 has only 2 days shelf life remaining (< 10 days required)
    // Allocate lot 2 to order
    f.sqlite
      .prepare(
        `INSERT INTO inventory_lot_allocations(id, lot_id, order_id, order_line_index, customer_id, quantity, correlation_id, created_at)
         VALUES(?, ?, ?, 1, ?, 1, 'seed-alloc-2', ?)`
      )
      .run(testUuid(), lotId2, orderId, CUSTOMER, utc())

    const eligibility = await evaluateOrderExpeditionEligibility(f.database, orderId, options)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.blockedLines.some((l) => l.reason === 'lot_expired')).toBe(true)
  })

  it('denies lot expedition commands to non-admin actors', async () => {
    await expect(
      blockLotExpedition(
        f.database,
        BUYER_CLAIMS,
        '99999999-9999-4999-8999-999999999999',
        { lotId: lotId1, blockReason: 'manual_quarantine', evidence: 'unauthorized-try' },
        options
      )
    ).rejects.toThrowError(CatalogLotRecallError)
  })

  it('rejects locating stock or customers for non-existent lot', async () => {
    const nonExistent = '99999999-9999-4999-8999-999999999999'
    await expect(locateLotAffectedStock(f.database, nonExistent)).rejects.toThrowError(
      new CatalogLotRecallError('not_found')
    )
    await expect(locateLotAffectedCustomers(f.database, nonExistent)).rejects.toThrowError(
      new CatalogLotRecallError('not_found')
    )
  })

  it('rejects blocking a non-existent lot with not_found', async () => {
    const nonExistent = '99999999-9999-4999-8999-999999999999'
    await expect(
      blockLotExpedition(
        f.database,
        CLAIMS,
        '88888888-8888-4888-8888-888888888888',
        { lotId: nonExistent, blockReason: 'manual_quarantine', evidence: 'missing-lot-test' },
        options
      )
    ).rejects.toThrowError(new CatalogLotRecallError('not_found'))
  })

  it('rejects invalid evidence string or invalid command ID with invalid_input', async () => {
    await expect(
      blockLotExpedition(
        f.database,
        CLAIMS,
        'not-a-uuid',
        { lotId: lotId1, blockReason: 'manual_quarantine', evidence: 'valid-evidence' },
        options
      )
    ).rejects.toThrowError(new CatalogLotRecallError('invalid_input'))

    await expect(
      blockLotExpedition(
        f.database,
        CLAIMS,
        '88888888-8888-4888-8888-888888888888',
        { lotId: lotId1, blockReason: 'manual_quarantine', evidence: 'bad evidence with spaces!@#' },
        options
      )
    ).rejects.toThrowError(new CatalogLotRecallError('invalid_input'))
  })

  it('evaluates order as eligible when allocated lot is active and unblocked', async () => {
    const freshOrderId = await f.order({ paid: true, delivered: false })
    f.sqlite
      .prepare(
        `INSERT INTO inventory_lot_allocations(id, lot_id, order_id, order_line_index, customer_id, quantity, correlation_id, created_at)
         VALUES(?, ?, ?, 0, ?, 1, 'fresh-alloc', ?)`
      )
      .run(testUuid(), lotId1, freshOrderId, CUSTOMER, utc())

    const eligibility = await evaluateOrderExpeditionEligibility(f.database, freshOrderId, options)
    expect(eligibility.eligible).toBe(true)
    expect(eligibility.blockedLines).toHaveLength(0)
  })
})
