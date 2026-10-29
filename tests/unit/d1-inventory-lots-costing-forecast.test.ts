import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  INVENTORY_FIXTURE_VARIANT
} from '../support/admin-inventory-fixture'
import { deterministicTestData, FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import {
  executeD1LotsCostingCommand,
  readD1LotTraceability,
  readD1AnalyticalMarginReport,
  evaluateD1DemandForecast,
  readD1ReorderSuggestions,
  readD1DemandAnomalies,
  listD1Lots,
  InventoryLotsCostingError
} from '../../workers/catalog/inventory-lots-costing-forecast'

const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const clock = { now: () => FIXED_TEST_INSTANT.replace('.000Z', 'Z') }

describe('INV-019, INV-021, INV-022 inventory lots, costing and forecast', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let data = deterministicTestData('lots-costing-forecast')

  const TEST_ORDER_ID = '50000000-0000-4000-8000-000000000001'
  const TEST_CUSTOMER_ID = '60000000-0000-4000-8000-000000000001'

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FIXED_TEST_INSTANT)
    data = deterministicTestData('lots-costing-forecast')
    ;({ sqlite, database } = await openAdminInventoryFixture())
    sqlite.exec(
      await readFile(
        new URL('../../db/d1/migrations/0106_inventory_lots_costing_forecast.sql', import.meta.url),
        'utf8'
      )
    )

    // Seed test customer and test order for traceability tests
    const dummyId = `dm-${TEST_ORDER_ID}`
    const tokenHash = 'a'.repeat(64)
    const expiresAt = '2030-01-01T00:00:00Z'
    sqlite.exec(`
      INSERT INTO customers(id,name,phone,status,created_at,updated_at)
        VALUES('${TEST_CUSTOMER_ID}','Cliente Test',NULL,'active','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
        VALUES('${dummyId}', '${tokenHash}', 'active', 1, '${expiresAt}', 'corr-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
        VALUES('${dummyId}', '${dummyId}', 1, '2026-01-01T00:00:00Z', 'EUR', 0, 1, 1000, 0, 1000, '${tokenHash}', 'corr-1', '2026-01-01T00:00:00Z');
      INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
        VALUES('${dummyId}', '${dummyId}', 1, '${tokenHash}', '[]', 0, '${tokenHash}', '${expiresAt}', 'corr-1', '2026-01-01T00:00:00Z');
      INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
        VALUES('${dummyId}', '${dummyId}', 'key-1', 'failed', 'corr-1', '${tokenHash}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
        VALUES('${TEST_ORDER_ID}', '${dummyId}', '${dummyId}', '${dummyId}', '${dummyId}', '${tokenHash}', 'awaiting_payment', 'res-1', '${expiresAt}', 'EUR', 1000, 0, 1000, 0, 0, 0, 'standard', 1, 1, 3, 'cliente@example.invalid', '${tokenHash}', 1, 1, 'corr-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '${TEST_CUSTOMER_ID}');
      INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
        VALUES('${TEST_ORDER_ID}',0,'${INVENTORY_FIXTURE_VARIANT}','SYNTHETIC-SKU','Synthetic item',10,121,1000,210,1210,2100,'price-ver-1','main','2026-01-01T00:00:00Z');
    `)
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  describe('INV-019: Lotes, caducidades y FEFO con trazabilidad a pedido y cliente', () => {
    it('creates a lot with expiration date and initial quantity', async () => {
      const lotCmdId = data.uuid()
      const receipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lotCmdId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'BATCH-2026-001',
          locationId: 'main',
          expiresAt: '2026-12-31T23:59:59Z',
          manufacturedAt: '2026-01-15T00:00:00Z',
          initialQuantity: 100,
          reason: 'Initial chemical batch receipt'
        },
        lotCmdId,
        clock
      )

      expect(receipt.action).toBe('create_lot')
      expect(receipt.resultVersion).toBe(1)

      const lots = await listD1Lots(database, INVENTORY_FIXTURE_VARIANT)
      expect(lots).toHaveLength(1)
      expect(lots[0]!.lotNumber).toBe('BATCH-2026-001')
      expect(lots[0]!.availableQuantity).toBe(100)
      expect(lots[0]!.status).toBe('active')
    })

    it('rejects duplicate lot number for same variant', async () => {
      const lotCmd1 = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lotCmd1,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'BATCH-DUP',
          expiresAt: '2026-12-31T23:59:59Z',
          initialQuantity: 50
        },
        lotCmd1,
        clock
      )

      const lotCmd2 = data.uuid()
      await expect(
        executeD1LotsCostingCommand(
          database,
          claims,
          'create_lot',
          lotCmd2,
          {
            variantId: INVENTORY_FIXTURE_VARIANT,
            lotNumber: 'BATCH-DUP',
            expiresAt: '2027-06-30T23:59:59Z',
            initialQuantity: 50
          },
          lotCmd2,
          clock
        )
      ).rejects.toThrow(InventoryLotsCostingError)
    })

    it('allocates using FEFO picking earliest expiring active lot first', async () => {
      // Create 3 lots with different expiries: Lot C (exp Dec 2026), Lot A (exp Aug 2026), Lot B (exp Oct 2026)
      const lot1Id = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lot1Id,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-C-DEC',
          expiresAt: '2026-12-31T23:59:59Z',
          initialQuantity: 50
        },
        lot1Id,
        clock
      )

      const lot2Id = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lot2Id,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-A-AUG',
          expiresAt: '2026-08-31T23:59:59Z',
          initialQuantity: 10
        },
        lot2Id,
        clock
      )

      const lot3Id = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lot3Id,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-B-OCT',
          expiresAt: '2026-10-31T23:59:59Z',
          initialQuantity: 20
        },
        lot3Id,
        clock
      )

      // Allocate 25 units: should take 10 from LOT-A-AUG (fully depleted), then 15 from LOT-B-OCT (leaves 5)
      const allocCmdId = data.uuid()
      const allocReceipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'allocate_fefo',
        allocCmdId,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          requestedQuantity: 25,
          customerId: TEST_CUSTOMER_ID,
          reason: 'Fulfill order with FEFO'
        },
        allocCmdId,
        clock
      )

      expect(allocReceipt.action).toBe('allocate_fefo')
      const result = allocReceipt.data as {
        totalAllocated: number
        fullyAllocated: boolean
        allocations: Array<{ lotNumber: string; allocatedQuantity: number }>
      }
      expect(result.totalAllocated).toBe(25)
      expect(result.fullyAllocated).toBe(true)
      expect(result.allocations).toHaveLength(2)
      expect(result.allocations[0]!.lotNumber).toBe('LOT-A-AUG')
      expect(result.allocations[0]!.allocatedQuantity).toBe(10)
      expect(result.allocations[1]!.lotNumber).toBe('LOT-B-OCT')
      expect(result.allocations[1]!.allocatedQuantity).toBe(15)

      // Verify lot balances
      const lots = await listD1Lots(database, INVENTORY_FIXTURE_VARIANT)
      const lotA = lots.find((l) => l.lotNumber === 'LOT-A-AUG')!
      expect(lotA.availableQuantity).toBe(0)
      expect(lotA.status).toBe('depleted')

      const lotB = lots.find((l) => l.lotNumber === 'LOT-B-OCT')!
      expect(lotB.availableQuantity).toBe(5)
      expect(lotB.status).toBe('active')
    })

    it('skips expired and quarantined lots during FEFO allocation', async () => {
      // Create an already-expired lot
      const expLotId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        expLotId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-EXPIRED',
          expiresAt: '2026-01-01T00:00:00Z', // Before FIXED_TEST_INSTANT (2026-10-29)
          initialQuantity: 10
        },
        expLotId,
        clock
      )

      // Create a valid lot
      const validLotId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        validLotId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-VALID',
          expiresAt: '2027-01-01T00:00:00Z',
          initialQuantity: 10
        },
        validLotId,
        clock
      )

      // Create a lot to quarantine
      const quarLotId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        quarLotId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'LOT-TO-QUARANTINE',
          expiresAt: '2026-11-01T00:00:00Z',
          initialQuantity: 10
        },
        quarLotId,
        clock
      )

      // Quarantine it
      const qCmdId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'quarantine_lot',
        quarLotId,
        {
          expectedVersion: 1,
          reason: 'Quality control chemical precipitation issue'
        },
        qCmdId,
        clock
      )

      // Allocate 5 units: must pick LOT-VALID, skipping expired and quarantined
      const allocCmdId = data.uuid()
      const allocReceipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'allocate_fefo',
        allocCmdId,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          requestedQuantity: 5,
          customerId: TEST_CUSTOMER_ID
        },
        allocCmdId,
        clock
      )

      const result = allocReceipt.data as {
        allocations: Array<{ lotNumber: string; allocatedQuantity: number }>
      }
      expect(result.allocations).toHaveLength(1)
      expect(result.allocations[0]!.lotNumber).toBe('LOT-VALID')
    })

    it('provides full bidirectional traceability between lot, order and customer', async () => {
      const lotId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        lotId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'TRACE-LOT-01',
          expiresAt: '2027-01-01T00:00:00Z',
          initialQuantity: 50
        },
        lotId,
        clock
      )

      const allocCmdId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'allocate_fefo',
        allocCmdId,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          requestedQuantity: 8,
          customerId: TEST_CUSTOMER_ID
        },
        allocCmdId,
        clock
      )

      // 1. Trace by Lot: find all orders/customers that received this lot
      const traceLot = await readD1LotTraceability(database, { lotNumber: 'TRACE-LOT-01' })
      expect(traceLot.source).toBe('cloudflare')
      expect(traceLot.totalUnitsTraced).toBe(8)
      expect(traceLot.records).toHaveLength(1)
      expect(traceLot.records[0]!.orderId).toBe(TEST_ORDER_ID)
      expect(traceLot.records[0]!.customerId).toBe(TEST_CUSTOMER_ID)
      expect(traceLot.records[0]!.customerEmail).toBe('cliente@example.invalid')

      // 2. Trace by Order: find all lots in order
      const traceOrder = await readD1LotTraceability(database, { orderId: TEST_ORDER_ID })
      expect(traceOrder.records).toHaveLength(1)
      expect(traceOrder.records[0]!.lotNumber).toBe('TRACE-LOT-01')

      // 3. Trace by Customer: find all lots delivered to customer
      const traceCustomer = await readD1LotTraceability(database, { customerId: TEST_CUSTOMER_ID })
      expect(traceCustomer.records).toHaveLength(1)
      expect(traceCustomer.records[0]!.lotNumber).toBe('TRACE-LOT-01')
    })
  })

  describe('INV-021: Coste medio/FIFO y reconciliación de margen analítico', () => {
    it('sets costing policy per variant and enforces CAS version', async () => {
      const cmdId = data.uuid()
      const receipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'set_costing_policy',
        INVENTORY_FIXTURE_VARIANT,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          method: 'fifo',
          expectedVersion: 0,
          reason: 'Switch to FIFO costing policy'
        },
        cmdId,
        clock
      )

      expect(receipt.action).toBe('set_costing_policy')
      expect(receipt.resultVersion).toBe(1)

      // Stale CAS version should fail
      const staleCmdId = data.uuid()
      await expect(
        executeD1LotsCostingCommand(
          database,
          claims,
          'set_costing_policy',
          INVENTORY_FIXTURE_VARIANT,
          {
            variantId: INVENTORY_FIXTURE_VARIANT,
            method: 'average_cost',
            expectedVersion: 0, // Should be 1
            reason: 'Stale update'
          },
          staleCmdId,
          clock
        )
      ).rejects.toThrow(InventoryLotsCostingError)
    })

    it('calculates weighted average cost across receipts and consumes COGS correctly', async () => {
      // 1. Receipt 10 units at 500 cents (5.00 EUR each) -> Total cost 5000 cents, Unit cost 500
      const rec1Cmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'record_cost_layer',
        rec1Cmd,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          locationId: 'main',
          unitCostCents: 500,
          quantity: 10
        },
        rec1Cmd,
        clock
      )

      // 2. Receipt 10 units at 700 cents (7.00 EUR each) -> (10*500 + 10*700)/20 = 12000/20 = 600 cents
      const rec2Cmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'record_cost_layer',
        rec2Cmd,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          locationId: 'main',
          unitCostCents: 700,
          quantity: 10
        },
        rec2Cmd,
        clock
      )

      // 3. Consume 5 units for an order line with revenueNetCents = 4500 cents (9.00 EUR each)
      // COGS = 5 * 600 = 3000 cents. Margin = 4500 - 3000 = 1500 cents (33.33% margin = 3333 basis points)
      const consumeCmd = data.uuid()
      const consumeReceipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'consume_cost',
        consumeCmd,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          locationId: 'main',
          quantity: 5,
          revenueNetCents: 4500
        },
        consumeCmd,
        clock
      )

      expect(consumeReceipt.action).toBe('consume_cost')
      const result = consumeReceipt.data as {
        unitCostCents: number
        totalCogsCents: number
        revenueNetCents: number
        marginCents: number
        marginBasisPoints: number
      }
      expect(result.unitCostCents).toBe(600)
      expect(result.totalCogsCents).toBe(3000)
      expect(result.marginCents).toBe(1500)
      expect(result.marginBasisPoints).toBe(3333)
    })

    it('calculates FIFO layer consumption and margin correctly', async () => {
      // Set variant to FIFO
      const policyCmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'set_costing_policy',
        INVENTORY_FIXTURE_VARIANT,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          method: 'fifo',
          expectedVersion: 0
        },
        policyCmd,
        clock
      )

      // Layer 1: 5 units @ 400 cents (2000 cents)
      const rec1Cmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'record_cost_layer',
        rec1Cmd,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          unitCostCents: 400,
          quantity: 5
        },
        rec1Cmd,
        clock
      )

      // Layer 2: 10 units @ 600 cents (6000 cents)
      const rec2Cmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'record_cost_layer',
        rec2Cmd,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          unitCostCents: 600,
          quantity: 10
        },
        rec2Cmd,
        clock
      )

      // Consume 8 units: takes 5 @ 400 (2000) + 3 @ 600 (1800) = total COGS 3800 cents.
      // Revenue is 8000 cents -> Margin = 8000 - 3800 = 4200 cents (5250 basis points)
      const consumeCmd = data.uuid()
      const consumeReceipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'consume_cost',
        consumeCmd,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          quantity: 8,
          revenueNetCents: 8000
        },
        consumeCmd,
        clock
      )

      const result = consumeReceipt.data as {
        totalCogsCents: number
        marginCents: number
        marginBasisPoints: number
      }
      expect(result.totalCogsCents).toBe(3800)
      expect(result.marginCents).toBe(4200)
      expect(result.marginBasisPoints).toBe(5250)
    })

    it('reconciles analytical gross margin with financial order revenue with 0 discrepancy', async () => {
      // Record cost receipt and consumption matching TEST_ORDER_ID line net_cents (1000 cents)
      const recCmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'record_cost_layer',
        recCmd,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          unitCostCents: 60,
          quantity: 10
        },
        recCmd,
        clock
      )

      const consumeCmd = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'consume_cost',
        consumeCmd,
        {
          orderId: TEST_ORDER_ID,
          orderLineIndex: 0,
          variantId: INVENTORY_FIXTURE_VARIANT,
          quantity: 10,
          revenueNetCents: 1000
        },
        consumeCmd,
        clock
      )

      const report = await readD1AnalyticalMarginReport(database, {
        variantId: INVENTORY_FIXTURE_VARIANT,
        periodStart: '2026-01-01T00:00:00Z',
        periodEnd: '2026-12-31T23:59:59Z'
      })

      expect(report.source).toBe('cloudflare')
      expect(report.totalRevenueNetCents).toBe(1000)
      expect(report.totalCogsCents).toBe(600)
      expect(report.analyticalGrossMarginCents).toBe(400)
      expect(report.analyticalGrossMarginBasisPoints).toBe(4000)
      expect(report.financialSourceRevenueNetCents).toBe(1000)
      expect(report.discrepancyCents).toBe(0)
      expect(report.reconciliationStatus).toBe('reconciled')
    })
  })

  describe('INV-022: Previsión de demanda, modelo vs baseline y sugerencias no destructivas', () => {
    it('evaluates advanced forecast model against naive/SMA baseline and measures MAE improvement', async () => {
      // Inject synthetic historical demand movements across several days
      const days = [5, 6, 7, 6, 8, 7, 9, 8, 10, 9]
      for (let i = 0; i < days.length; i++) {
        const d = String(i + 1).padStart(2, '0')
        sqlite
          .prepare(
            `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at)
             VALUES(?,'${INVENTORY_FIXTURE_VARIANT}','main','ship',?,0,'order',?,?,'2026-10-${d}T12:00:00Z')`
          )
          .run(data.uuid(), -days[i]!, data.uuid(), 'test-corr')
      }

      const evaluation = await evaluateD1DemandForecast(database, INVENTORY_FIXTURE_VARIANT, {
        leadTimeDays: 7,
        historyDays: 10,
        clock
      })

      expect(evaluation.variantId).toBe(INVENTORY_FIXTURE_VARIANT)
      expect(evaluation.baselineModel).toBe('simple_moving_average')
      expect(evaluation.advancedModel).toBe('exponential_smoothing')
      expect(evaluation.baselineMae).toBeGreaterThan(0)
      expect(evaluation.advancedMae).toBeGreaterThan(0)
      expect(typeof evaluation.maeImprovementPercent).toBe('number')
      expect(evaluation.forecastDailyDemand).toBeGreaterThan(0)
    })

    it('generates a suggestion when stock drops below reorder point without irreversible automatic mutations', async () => {
      // Current physical quantity is 20, safety stock is 2.
      // Daily forecast = 5 units, lead time = 5 days -> Reorder point = 5*5 + 2 = 27 units.
      // Since 20 <= 27, it should generate a reorder suggestion with status 'suggested'.
      const days = [5, 5, 5, 5, 5]
      for (let i = 0; i < days.length; i++) {
        const d = String(i + 1).padStart(2, '0')
        sqlite
          .prepare(
            `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at)
             VALUES(?,'${INVENTORY_FIXTURE_VARIANT}','main','ship',-5,0,'order',?,?,'2026-10-${d}T12:00:00Z')`
          )
          .run(data.uuid(), data.uuid(), 'test-corr')
      }

      const evalResult = await evaluateD1DemandForecast(database, INVENTORY_FIXTURE_VARIANT, {
        leadTimeDays: 5,
        historyDays: 5,
        clock
      })

      expect(evalResult.reorderSuggestion).toBeDefined()
      expect(evalResult.reorderSuggestion!.status).toBe('suggested')
      expect(evalResult.reorderSuggestion!.suggestedQuantity).toBeGreaterThan(0)

      // Crucial verification: NO automatic purchase or balance change occurred
      const balance = sqlite
        .prepare('SELECT physical_quantity FROM inventory_balances WHERE variant_id=?')
        .get(INVENTORY_FIXTURE_VARIANT) as { physical_quantity: number }
      expect(balance.physical_quantity).toBe(20)

      // Review the suggestion by operator
      const reviewCmd = data.uuid()
      const receipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'review_suggestion',
        evalResult.reorderSuggestion!.id,
        {
          suggestionId: evalResult.reorderSuggestion!.id,
          action: 'review',
          reason: 'Operator confirmed supplier lead time and accepted reorder quantity'
        },
        reviewCmd,
        clock
      )

      expect(receipt.action).toBe('review_suggestion')
      const suggestions = await readD1ReorderSuggestions(database, INVENTORY_FIXTURE_VARIANT)
      expect(suggestions[0]!.status).toBe('reviewed')
      expect(suggestions[0]!.reviewedBy).toBe(INVENTORY_FIXTURE_ACTOR)
    })

    it('detects demand anomalies (spikes and drops) and allows acknowledgment', async () => {
      // Normal demand: 2 units/day
      for (let i = 1; i <= 8; i++) {
        const d = String(i).padStart(2, '0')
        sqlite
          .prepare(
            `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at)
             VALUES(?,'${INVENTORY_FIXTURE_VARIANT}','main','ship',-2,0,'order',?,?,'2026-10-${d}T12:00:00Z')`
          )
          .run(data.uuid(), data.uuid(), 'test-corr')
      }

      // Massive spike on day 9: 50 units (statistical anomaly!)
      sqlite
        .prepare(
          `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at)
           VALUES(?,'${INVENTORY_FIXTURE_VARIANT}','main','ship',-50,0,'order',?,?,'2026-10-09T12:00:00Z')`
        )
        .run(data.uuid(), data.uuid(), 'test-corr')

      const evalResult = await evaluateD1DemandForecast(database, INVENTORY_FIXTURE_VARIANT, {
        leadTimeDays: 3,
        historyDays: 9,
        clock
      })

      expect(evalResult.anomalies.length).toBeGreaterThan(0)
      const anomaly = evalResult.anomalies[0]!
      expect(anomaly.kind).toBe('spike')
      expect(anomaly.severity).toBe('critical')
      expect(anomaly.status).toBe('open')

      // Operator acknowledges anomaly
      const ackCmd = data.uuid()
      const ackReceipt = await executeD1LotsCostingCommand(
        database,
        claims,
        'ack_anomaly',
        anomaly.id,
        {
          anomalyId: anomaly.id,
          reason: 'One-off institutional bulk hospital cleaning purchase'
        },
        ackCmd,
        clock
      )

      expect(ackReceipt.action).toBe('ack_anomaly')
      const anomalies = await readD1DemandAnomalies(database, INVENTORY_FIXTURE_VARIANT)
      expect(anomalies[0]!.status).toBe('acknowledged')
    })
  })

  describe('Idempotency, CAS and ledger immutability', () => {
    it('returns identical receipt on duplicate command with identical payload hash', async () => {
      const cmdId = data.uuid()
      const payload = {
        variantId: INVENTORY_FIXTURE_VARIANT,
        lotNumber: 'IDEMP-LOT-01',
        expiresAt: '2027-01-01T00:00:00Z',
        initialQuantity: 15
      }

      const receipt1 = await executeD1LotsCostingCommand(database, claims, 'create_lot', cmdId, payload, cmdId, clock)
      const receipt2 = await executeD1LotsCostingCommand(database, claims, 'create_lot', cmdId, payload, cmdId, clock)

      expect(receipt1.commandId).toBe(cmdId)
      expect(receipt2.commandId).toBe(cmdId)
      expect(receipt1.payloadHash).toBe(receipt2.payloadHash)
    })

    it('rejects duplicate command_id with altered payload', async () => {
      const cmdId = data.uuid()
      await executeD1LotsCostingCommand(
        database,
        claims,
        'create_lot',
        cmdId,
        {
          variantId: INVENTORY_FIXTURE_VARIANT,
          lotNumber: 'IDEMP-TAMPER-1',
          expiresAt: '2027-01-01T00:00:00Z',
          initialQuantity: 10
        },
        cmdId,
        clock
      )

      await expect(
        executeD1LotsCostingCommand(
          database,
          claims,
          'create_lot',
          cmdId,
          {
            variantId: INVENTORY_FIXTURE_VARIANT,
            lotNumber: 'IDEMP-TAMPER-2', // changed payload
            expiresAt: '2027-01-01T00:00:00Z',
            initialQuantity: 20
          },
          cmdId,
          clock
        )
      ).rejects.toThrow(InventoryLotsCostingError)
    })
  })
})
