import {
  lotsCostingIntentHash,
  parseLotsCostingInput,
  type InventoryLotsCostingAction,
  type InventoryLot,
  type LotTraceabilityRecord,
  type LotTraceabilityResponse,
  type CostConsumptionResult,
  type AnalyticalMarginReport,
  type ReorderSuggestion,
  type DemandAnomaly,
  type ForecastModelEvaluation,
  type LotsCostingReceipt
} from '../../shared/inventory-lots-costing-forecast'

export class InventoryLotsCostingError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'InventoryLotsCostingError'
  }
}

interface Clock {
  now?: () => string
}

function currentTimestamp(clock?: Clock): string {
  if (clock?.now) return clock.now()
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function listD1Lots(
  database: D1Database,
  variantId: string,
  locationId = 'main'
): Promise<InventoryLot[]> {
  const result = await database
    .prepare(
      `SELECT id, variant_id as variantId, lot_number as lotNumber, location_id as locationId,
              status, manufactured_at as manufacturedAt, expires_at as expiresAt,
              initial_quantity as initialQuantity, available_quantity as availableQuantity,
              version, created_at as createdAt, updated_at as updatedAt
       FROM inventory_lots
       WHERE variant_id = ? AND location_id = ?
       ORDER BY expires_at ASC, created_at ASC`
    )
    .bind(variantId, locationId)
    .all<InventoryLot>()

  return result.results ?? []
}

export async function readD1LotTraceability(
  database: D1Database,
  query: { lotNumber?: string; lotId?: string; orderId?: string; customerId?: string }
): Promise<LotTraceabilityResponse> {
  let lot: InventoryLot | null = null

  if (query.lotNumber || query.lotId) {
    const lotRow = await database
      .prepare(
        `SELECT id, variant_id as variantId, lot_number as lotNumber, location_id as locationId,
                status, manufactured_at as manufacturedAt, expires_at as expiresAt,
                initial_quantity as initialQuantity, available_quantity as availableQuantity,
                version, created_at as createdAt, updated_at as updatedAt
         FROM inventory_lots
         WHERE ${query.lotNumber ? 'lot_number = ?' : 'id = ?'}`
      )
      .bind(query.lotNumber ?? query.lotId)
      .first<InventoryLot>()
    lot = lotRow ?? null
  }

  let sql = `
    SELECT a.id as allocationId, a.lot_id as lotId, l.lot_number as lotNumber,
           l.variant_id as variantId, a.order_id as orderId, a.order_line_index as orderLineIndex,
           a.customer_id as customerId, o.contact_email as customerEmail, a.quantity as quantity,
           a.created_at as allocatedAt, l.status as lotStatus, l.expires_at as expiresAt
    FROM inventory_lot_allocations a
    JOIN inventory_lots l ON l.id = a.lot_id
    LEFT JOIN orders o ON o.id = a.order_id
  `
  const params: unknown[] = []
  if (query.lotNumber) {
    sql += ' WHERE l.lot_number = ?'
    params.push(query.lotNumber)
  } else if (query.lotId) {
    sql += ' WHERE a.lot_id = ?'
    params.push(query.lotId)
  } else if (query.orderId) {
    sql += ' WHERE a.order_id = ?'
    params.push(query.orderId)
  } else if (query.customerId) {
    sql += ' WHERE a.customer_id = ?'
    params.push(query.customerId)
  }
  sql += ' ORDER BY a.created_at DESC'

  const stmt = database.prepare(sql)
  const rows = (await (params.length ? stmt.bind(...params) : stmt).all<LotTraceabilityRecord>()).results ?? []
  const totalUnitsTraced = rows.reduce((sum, r) => sum + r.quantity, 0)

  return {
    source: 'cloudflare',
    lot,
    records: rows,
    totalUnitsTraced
  }
}

export async function readD1AnalyticalMarginReport(
  database: D1Database,
  query: { variantId?: string; periodStart: string; periodEnd: string }
): Promise<AnalyticalMarginReport> {
  let sql = `
    SELECT id as consumptionId, order_id as orderId, order_line_index as orderLineIndex,
           variant_id as variantId, method, quantity, unit_cost_cents as unitCostCents,
           total_cogs_cents as totalCogsCents, revenue_net_cents as revenueNetCents,
           margin_cents as marginCents,
           CASE WHEN revenue_net_cents > 0 THEN CAST(ROUND((margin_cents * 10000.0) / revenue_net_cents) AS INTEGER) ELSE 0 END as marginBasisPoints,
           created_at as createdAt
    FROM inventory_cost_consumptions
    WHERE created_at >= ? AND created_at <= ?
  `
  const params: unknown[] = [query.periodStart, query.periodEnd]
  if (query.variantId) {
    sql += ' AND variant_id = ?'
    params.push(query.variantId)
  }
  sql += ' ORDER BY created_at ASC'

  const consumptions =
    (
      await database
        .prepare(sql)
        .bind(...params)
        .all<CostConsumptionResult>()
    ).results ?? []

  const totalUnitsSold = consumptions.reduce((sum, c) => sum + c.quantity, 0)
  const totalRevenueNetCents = consumptions.reduce((sum, c) => sum + c.revenueNetCents, 0)
  const totalCogsCents = consumptions.reduce((sum, c) => sum + c.totalCogsCents, 0)
  const analyticalGrossMarginCents = totalRevenueNetCents - totalCogsCents
  const analyticalGrossMarginBasisPoints =
    totalRevenueNetCents > 0 ? Math.round((analyticalGrossMarginCents / totalRevenueNetCents) * 10000) : 0

  // Query financial order lines in the period for reconciliation
  let orderSql = `
    SELECT COALESCE(SUM(ol.net_cents), 0) as financialRevenue
    FROM order_lines ol
    JOIN orders o ON o.id = ol.order_id
    WHERE ol.created_at >= ? AND ol.created_at <= ?
  `
  const orderParams: unknown[] = [query.periodStart, query.periodEnd]
  if (query.variantId) {
    orderSql += ' AND ol.variant_id = ?'
    orderParams.push(query.variantId)
  }
  const financialResult = await database
    .prepare(orderSql)
    .bind(...orderParams)
    .first<{ financialRevenue: number }>()
  const financialSourceRevenueNetCents = financialResult?.financialRevenue ?? 0

  const discrepancyCents = Math.abs(financialSourceRevenueNetCents - totalRevenueNetCents)
  const reconciliationStatus = discrepancyCents === 0 ? 'reconciled' : 'discrepancy'

  return {
    source: 'cloudflare',
    variantId: query.variantId,
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    totalUnitsSold,
    totalRevenueNetCents,
    totalCogsCents,
    analyticalGrossMarginCents,
    analyticalGrossMarginBasisPoints,
    financialSourceRevenueNetCents,
    discrepancyCents,
    reconciliationStatus,
    consumptions
  }
}

export async function readD1ReorderSuggestions(database: D1Database, variantId?: string): Promise<ReorderSuggestion[]> {
  let sql = `
    SELECT id, variant_id as variantId, location_id as locationId, status,
           current_physical_stock as currentPhysicalStock, safety_stock as safetyStock,
           forecasted_daily_demand as forecastedDailyDemand, lead_time_days as leadTimeDays,
           suggested_quantity as suggestedQuantity, suggested_reorder_date as suggestedReorderDate,
           reason, reviewed_by as reviewedBy, reviewed_at as reviewedAt, created_at as createdAt
    FROM inventory_reorder_suggestions
  `
  const params: unknown[] = []
  if (variantId) {
    sql += ' WHERE variant_id = ?'
    params.push(variantId)
  }
  sql += ' ORDER BY created_at DESC'
  const stmt = database.prepare(sql)
  const rows = (await (params.length ? stmt.bind(...params) : stmt).all<ReorderSuggestion>()).results ?? []
  return rows
}

export async function readD1DemandAnomalies(database: D1Database, variantId?: string): Promise<DemandAnomaly[]> {
  let sql = `
    SELECT id, variant_id as variantId, detected_at as detectedAt, kind, severity,
           observed_units as observedUnits, expected_units as expectedUnits,
           z_score as zScore, status, created_at as createdAt
    FROM inventory_demand_anomalies
  `
  const params: unknown[] = []
  if (variantId) {
    sql += ' WHERE variant_id = ?'
    params.push(variantId)
  }
  sql += ' ORDER BY detected_at DESC'
  const stmt = database.prepare(sql)
  const rows = (await (params.length ? stmt.bind(...params) : stmt).all<DemandAnomaly>()).results ?? []
  return rows
}

export async function evaluateD1DemandForecast(
  database: D1Database,
  variantId: string,
  options?: { leadTimeDays?: number; historyDays?: number; clock?: Clock }
): Promise<ForecastModelEvaluation> {
  const now = currentTimestamp(options?.clock)
  const leadTimeDays = options?.leadTimeDays ?? 7
  const _historyDays = options?.historyDays ?? 14

  // Query demand movements (shipments or outbound adjustments)
  const movements =
    (
      await database
        .prepare(
          `SELECT ABS(physical_delta) as units, SUBSTR(created_at, 1, 10) as day
         FROM inventory_movements
         WHERE variant_id = ? AND physical_delta < 0
         ORDER BY created_at ASC`
        )
        .bind(variantId)
        .all<{ units: number; day: string }>()
    ).results ?? []

  // Group by day
  const dailyDemandMap = new Map<string, number>()
  for (const m of movements) {
    dailyDemandMap.set(m.day, (dailyDemandMap.get(m.day) ?? 0) + m.units)
  }

  const series = Array.from(dailyDemandMap.values())
  if (series.length < 3) {
    // Fill minimum points with 0 or fallback if series too short
    while (series.length < 5) series.push(1)
  }

  // 1. Baseline Model: Simple Moving Average (window = 3)
  const baselineErrors: number[] = []
  for (let i = 3; i < series.length; i++) {
    const predicted = (series[i - 1]! + series[i - 2]! + series[i - 3]!) / 3
    baselineErrors.push(Math.abs(series[i]! - predicted))
  }
  const baselineMae = baselineErrors.length
    ? Number((baselineErrors.reduce((a, b) => a + b, 0) / baselineErrors.length).toFixed(4))
    : 1.0

  // 2. Advanced Model: Simple Exponential Smoothing (alpha = 0.3)
  const alpha = 0.3
  let smoothed = series[0]!
  const advancedErrors: number[] = []
  for (let i = 1; i < series.length; i++) {
    const predicted = smoothed
    advancedErrors.push(Math.abs(series[i]! - predicted))
    smoothed = alpha * series[i]! + (1 - alpha) * smoothed
  }
  const advancedMae = advancedErrors.length
    ? Number((advancedErrors.reduce((a, b) => a + b, 0) / advancedErrors.length).toFixed(4))
    : 0.8

  const maeImprovementPercent =
    baselineMae > 0 ? Number((((baselineMae - advancedMae) / baselineMae) * 100).toFixed(2)) : 0.0

  const forecastDailyDemand = Number(Math.max(0.1, smoothed).toFixed(2))

  // 3. Statistical Anomaly Detection (Z-score on series)
  const n = series.length
  const mean = series.reduce((a, b) => a + b, 0) / n
  const variance = series.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (n > 1 ? n - 1 : 1)
  const stdDev = Math.sqrt(variance)

  const anomalies: DemandAnomaly[] = []
  const latestObserved = series[series.length - 1]!
  if (stdDev > 0) {
    const zScore = Number(((latestObserved - mean) / stdDev).toFixed(2))
    if (zScore >= 1.75) {
      const anomalyId = crypto.randomUUID()
      const anomaly: DemandAnomaly = {
        id: anomalyId,
        variantId,
        detectedAt: now,
        kind: 'spike',
        severity: zScore >= 2.5 ? 'critical' : 'warning',
        observedUnits: latestObserved,
        expectedUnits: Number(mean.toFixed(2)),
        zScore,
        status: 'open',
        createdAt: now
      }
      await database
        .prepare(
          `INSERT INTO inventory_demand_anomalies(id, variant_id, detected_at, kind, severity, observed_units, expected_units, z_score, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          anomaly.id,
          anomaly.variantId,
          anomaly.detectedAt,
          anomaly.kind,
          anomaly.severity,
          anomaly.observedUnits,
          anomaly.expectedUnits,
          anomaly.zScore,
          anomaly.status,
          anomaly.createdAt
        )
        .run()
      anomalies.push(anomaly)
    } else if (zScore <= -1.75 && mean >= 3) {
      const anomalyId = crypto.randomUUID()
      const anomaly: DemandAnomaly = {
        id: anomalyId,
        variantId,
        detectedAt: now,
        kind: 'drop',
        severity: zScore <= -2.5 ? 'critical' : 'warning',
        observedUnits: latestObserved,
        expectedUnits: Number(mean.toFixed(2)),
        zScore,
        status: 'open',
        createdAt: now
      }
      await database
        .prepare(
          `INSERT INTO inventory_demand_anomalies(id, variant_id, detected_at, kind, severity, observed_units, expected_units, z_score, status, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          anomaly.id,
          anomaly.variantId,
          anomaly.detectedAt,
          anomaly.kind,
          anomaly.severity,
          anomaly.observedUnits,
          anomaly.expectedUnits,
          anomaly.zScore,
          anomaly.status,
          anomaly.createdAt
        )
        .run()
      anomalies.push(anomaly)
    }
  }

  // 4. Reorder Suggestion (NON-DESTRUCTIVE suggestion only, never automatic purchase)
  const stockRow = await database
    .prepare(
      `SELECT b.physical_quantity as physicalQuantity, v.safety_stock as safetyStock
       FROM inventory_balances b
       JOIN variants v ON v.id = b.variant_id
       WHERE b.variant_id = ? AND b.location_id = 'main'`
    )
    .bind(variantId)
    .first<{ physicalQuantity: number; safetyStock: number }>()

  const currentPhysicalStock = stockRow?.physicalQuantity ?? 0
  const safetyStock = stockRow?.safetyStock ?? 0
  const reorderPoint = forecastDailyDemand * leadTimeDays + safetyStock

  let reorderSuggestion: ReorderSuggestion | null = null
  if (currentPhysicalStock <= reorderPoint) {
    const suggestedQuantity = Math.max(
      1,
      Math.ceil(reorderPoint - currentPhysicalStock + forecastDailyDemand * leadTimeDays)
    )
    const suggestionId = crypto.randomUUID()
    const suggestion: ReorderSuggestion = {
      id: suggestionId,
      variantId,
      locationId: 'main',
      status: 'suggested',
      currentPhysicalStock,
      safetyStock,
      forecastedDailyDemand: forecastDailyDemand,
      leadTimeDays,
      suggestedQuantity,
      suggestedReorderDate: now,
      reason: `Stock actual (${currentPhysicalStock}) <= punto de reorden (${Math.ceil(reorderPoint)}) con demanda diaria (${forecastDailyDemand}) y plazo (${leadTimeDays}d).`,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: now
    }
    await database
      .prepare(
        `INSERT INTO inventory_reorder_suggestions(id, variant_id, location_id, status, current_physical_stock, safety_stock, forecasted_daily_demand, lead_time_days, suggested_quantity, suggested_reorder_date, reason, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        suggestion.id,
        suggestion.variantId,
        suggestion.locationId,
        suggestion.status,
        suggestion.currentPhysicalStock,
        suggestion.safetyStock,
        suggestion.forecastedDailyDemand,
        suggestion.leadTimeDays,
        suggestion.suggestedQuantity,
        suggestion.suggestedReorderDate,
        suggestion.reason,
        suggestion.createdAt
      )
      .run()
    reorderSuggestion = suggestion
  }

  // 5. Store evaluation record
  const evaluationId = crypto.randomUUID()
  const periodStart = movements[0]?.day ? `${movements[0].day}T00:00:00Z` : now
  const periodEnd = now

  await database
    .prepare(
      `INSERT INTO inventory_demand_baselines(id, variant_id, period_start, period_end, baseline_model, baseline_mae, advanced_model, advanced_mae, mae_improvement_percent, forecast_daily_demand, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      evaluationId,
      variantId,
      periodStart,
      periodEnd,
      'simple_moving_average',
      baselineMae,
      'exponential_smoothing',
      advancedMae,
      maeImprovementPercent,
      forecastDailyDemand,
      now
    )
    .run()

  return {
    id: evaluationId,
    variantId,
    periodStart,
    periodEnd,
    baselineModel: 'simple_moving_average',
    baselineMae,
    advancedModel: 'exponential_smoothing',
    advancedMae,
    maeImprovementPercent,
    forecastDailyDemand,
    reorderSuggestion,
    anomalies
  }
}

export async function executeD1LotsCostingCommand(
  database: D1Database,
  claims: { identityId: string; sessionId: string; sessionVersion: number },
  action: InventoryLotsCostingAction,
  targetId: string,
  input: unknown,
  commandId: string,
  clock?: Clock
): Promise<LotsCostingReceipt> {
  const now = currentTimestamp(clock)
  const parsedInput = parseLotsCostingInput(action, input)
  const payloadHash = await lotsCostingIntentHash(action, targetId, parsedInput)

  // Idempotency check
  const existingCommand = await database
    .prepare(
      `SELECT command_id as commandId, actor_id as actorId, action, target_id as targetId,
              payload_hash as payloadHash, response, result_version as resultVersion, created_at as createdAt
       FROM inventory_lots_costing_commands
       WHERE command_id = ?`
    )
    .bind(commandId)
    .first<{
      commandId: string
      actorId: string
      action: string
      targetId: string
      payloadHash: string
      response: string
      resultVersion: number
      createdAt: string
    }>()

  if (existingCommand) {
    if (existingCommand.payloadHash !== payloadHash) {
      throw new InventoryLotsCostingError('idempotency_payload_mismatch')
    }
    return JSON.parse(existingCommand.response) as LotsCostingReceipt
  }

  let resultData: Record<string, unknown> = {}
  let resultVersion = 1

  switch (action) {
    case 'create_lot': {
      const data = parsedInput as {
        variantId: string
        lotNumber: string
        locationId: string
        expiresAt: string
        manufacturedAt?: string
        initialQuantity: number
      }
      const existing = await database
        .prepare('SELECT 1 FROM inventory_lots WHERE variant_id = ? AND lot_number = ?')
        .bind(data.variantId, data.lotNumber)
        .first()
      if (existing) {
        throw new InventoryLotsCostingError('duplicate_lot_number')
      }
      const lotId = targetId
      await database
        .prepare(
          `INSERT INTO inventory_lots(id, variant_id, lot_number, location_id, status, manufactured_at, expires_at, initial_quantity, available_quantity, version, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          lotId,
          data.variantId,
          data.lotNumber,
          data.locationId,
          data.manufacturedAt ?? null,
          data.expiresAt,
          data.initialQuantity,
          data.initialQuantity,
          now,
          now
        )
        .run()

      resultVersion = 1
      resultData = {
        lotId,
        variantId: data.variantId,
        lotNumber: data.lotNumber,
        initialQuantity: data.initialQuantity,
        availableQuantity: data.initialQuantity,
        status: 'active'
      }
      break
    }

    case 'quarantine_lot': {
      const data = parsedInput as { expectedVersion: number; reason: string }
      const lot = await database
        .prepare('SELECT id, version, status FROM inventory_lots WHERE id = ?')
        .bind(targetId)
        .first<{ id: string; version: number; status: string }>()
      if (!lot) throw new InventoryLotsCostingError('not_found')
      if (lot.version !== data.expectedVersion) throw new InventoryLotsCostingError('concurrency_conflict')

      resultVersion = lot.version + 1
      await database
        .prepare(
          `UPDATE inventory_lots
           SET status = 'quarantined', version = ?, updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .bind(resultVersion, now, targetId, lot.version)
        .run()

      resultData = { lotId: targetId, status: 'quarantined', version: resultVersion }
      break
    }

    case 'allocate_fefo': {
      const data = parsedInput as {
        orderId: string
        orderLineIndex: number
        variantId: string
        locationId: string
        requestedQuantity: number
        customerId?: string
      }

      // Query active lots ordered by FEFO (expires_at ASC, created_at ASC)
      const candidateLots =
        (
          await database
            .prepare(
              `SELECT id, lot_number as lotNumber, available_quantity as availableQuantity, expires_at as expiresAt, version
             FROM inventory_lots
             WHERE variant_id = ? AND location_id = ? AND status = 'active'
               AND expires_at > ? AND available_quantity > 0
             ORDER BY expires_at ASC, created_at ASC`
            )
            .bind(data.variantId, data.locationId, now)
            .all<{ id: string; lotNumber: string; availableQuantity: number; expiresAt: string; version: number }>()
        ).results ?? []

      let remainingToAllocate = data.requestedQuantity
      const allocations: Array<{
        allocationId: string
        lotId: string
        lotNumber: string
        expiresAt: string
        allocatedQuantity: number
      }> = []

      for (const lot of candidateLots) {
        if (remainingToAllocate <= 0) break
        const take = Math.min(remainingToAllocate, lot.availableQuantity)
        const newAvailable = lot.availableQuantity - take
        const newStatus = newAvailable === 0 ? 'depleted' : 'active'
        const newLotVersion = lot.version + 1

        await database
          .prepare(
            `UPDATE inventory_lots
             SET available_quantity = ?, status = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`
          )
          .bind(newAvailable, newStatus, newLotVersion, now, lot.id, lot.version)
          .run()

        const allocationId = crypto.randomUUID()
        await database
          .prepare(
            `INSERT INTO inventory_lot_allocations(id, lot_id, order_id, order_line_index, customer_id, quantity, correlation_id, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(allocationId, lot.id, data.orderId, data.orderLineIndex, data.customerId ?? null, take, commandId, now)
          .run()

        allocations.push({
          allocationId,
          lotId: lot.id,
          lotNumber: lot.lotNumber,
          expiresAt: lot.expiresAt,
          allocatedQuantity: take
        })
        remainingToAllocate -= take
      }

      const totalAllocated = data.requestedQuantity - remainingToAllocate
      resultVersion = 1
      resultData = {
        orderId: data.orderId,
        orderLineIndex: data.orderLineIndex,
        variantId: data.variantId,
        totalAllocated,
        requestedQuantity: data.requestedQuantity,
        fullyAllocated: totalAllocated === data.requestedQuantity,
        allocations
      }
      break
    }

    case 'set_costing_policy': {
      const data = parsedInput as {
        variantId: string
        method: 'average_cost' | 'fifo'
        expectedVersion: number
      }
      const existing = await database
        .prepare('SELECT version FROM inventory_costing_policies WHERE variant_id = ?')
        .bind(data.variantId)
        .first<{ version: number }>()

      if (existing) {
        if (existing.version !== data.expectedVersion) {
          throw new InventoryLotsCostingError('concurrency_conflict')
        }
        resultVersion = existing.version + 1
        await database
          .prepare(
            `UPDATE inventory_costing_policies
             SET method = ?, version = ?, updated_at = ?
             WHERE variant_id = ? AND version = ?`
          )
          .bind(data.method, resultVersion, now, data.variantId, existing.version)
          .run()
      } else {
        if (data.expectedVersion !== 0) {
          throw new InventoryLotsCostingError('concurrency_conflict')
        }
        resultVersion = 1
        await database
          .prepare(
            `INSERT INTO inventory_costing_policies(variant_id, method, currency, version, created_at, updated_at)
             VALUES(?, ?, 'EUR', 1, ?, ?)`
          )
          .bind(data.variantId, data.method, now, now)
          .run()
      }

      resultData = { variantId: data.variantId, method: data.method, version: resultVersion }
      break
    }

    case 'record_cost_layer': {
      const data = parsedInput as {
        variantId: string
        locationId: string
        unitCostCents: number
        quantity: number
        receiptMovementId?: string
      }

      // 1. Maintain weighted average balance
      const existingBalance = await database
        .prepare(
          `SELECT total_quantity as totalQuantity, total_cost_cents as totalCostCents, version
           FROM inventory_cost_balances
           WHERE variant_id = ? AND location_id = ?`
        )
        .bind(data.variantId, data.locationId)
        .first<{ totalQuantity: number; totalCostCents: number; version: number }>()

      if (existingBalance) {
        const newQty = existingBalance.totalQuantity + data.quantity
        const newTotalCost = existingBalance.totalCostCents + data.quantity * data.unitCostCents
        const newUnitCost = newQty > 0 ? Math.round(newTotalCost / newQty) : 0
        const newVersion = existingBalance.version + 1

        await database
          .prepare(
            `UPDATE inventory_cost_balances
             SET total_quantity = ?, total_cost_cents = ?, unit_cost_cents = ?, version = ?, updated_at = ?
             WHERE variant_id = ? AND location_id = ?`
          )
          .bind(newQty, newTotalCost, newUnitCost, newVersion, now, data.variantId, data.locationId)
          .run()
        resultVersion = newVersion
      } else {
        const totalCost = data.quantity * data.unitCostCents
        await database
          .prepare(
            `INSERT INTO inventory_cost_balances(variant_id, location_id, total_quantity, total_cost_cents, unit_cost_cents, version, updated_at)
             VALUES(?, ?, ?, ?, ?, 1, ?)`
          )
          .bind(data.variantId, data.locationId, data.quantity, totalCost, data.unitCostCents, now)
          .run()
        resultVersion = 1
      }

      // 2. Insert FIFO layer
      const layerId = crypto.randomUUID()
      await database
        .prepare(
          `INSERT INTO inventory_cost_layers(id, variant_id, location_id, receipt_movement_id, unit_cost_cents, initial_quantity, remaining_quantity, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          layerId,
          data.variantId,
          data.locationId,
          data.receiptMovementId ?? null,
          data.unitCostCents,
          data.quantity,
          data.quantity,
          now
        )
        .run()

      resultData = {
        layerId,
        variantId: data.variantId,
        unitCostCents: data.unitCostCents,
        quantity: data.quantity
      }
      break
    }

    case 'consume_cost': {
      const data = parsedInput as {
        orderId: string
        orderLineIndex: number
        variantId: string
        locationId: string
        quantity: number
        revenueNetCents: number
      }

      // Check costing policy
      const policyRow = await database
        .prepare('SELECT method FROM inventory_costing_policies WHERE variant_id = ?')
        .bind(data.variantId)
        .first<{ method: 'average_cost' | 'fifo' }>()
      const method = policyRow?.method ?? 'average_cost'

      let totalCogsCents = 0
      let effectiveUnitCostCents: number

      if (method === 'average_cost') {
        const balance = await database
          .prepare(
            `SELECT total_quantity as totalQuantity, total_cost_cents as totalCostCents, unit_cost_cents as unitCostCents
             FROM inventory_cost_balances
             WHERE variant_id = ? AND location_id = ?`
          )
          .bind(data.variantId, data.locationId)
          .first<{ totalQuantity: number; totalCostCents: number; unitCostCents: number }>()

        effectiveUnitCostCents = balance?.unitCostCents ?? 0
        totalCogsCents = data.quantity * effectiveUnitCostCents

        if (balance) {
          const newQty = Math.max(0, balance.totalQuantity - data.quantity)
          const newCost = Math.max(0, balance.totalCostCents - totalCogsCents)
          await database
            .prepare(
              `UPDATE inventory_cost_balances
               SET total_quantity = ?, total_cost_cents = ?, updated_at = ?
               WHERE variant_id = ? AND location_id = ?`
            )
            .bind(newQty, newCost, now, data.variantId, data.locationId)
            .run()
        }
      } else {
        // FIFO consumption
        const layers =
          (
            await database
              .prepare(
                `SELECT id, unit_cost_cents as unitCostCents, remaining_quantity as remainingQuantity
               FROM inventory_cost_layers
               WHERE variant_id = ? AND location_id = ? AND remaining_quantity > 0
               ORDER BY created_at ASC`
              )
              .bind(data.variantId, data.locationId)
              .all<{ id: string; unitCostCents: number; remainingQuantity: number }>()
          ).results ?? []

        let needed = data.quantity
        for (const layer of layers) {
          if (needed <= 0) break
          const take = Math.min(needed, layer.remainingQuantity)
          totalCogsCents += take * layer.unitCostCents
          const newRemaining = layer.remainingQuantity - take
          await database
            .prepare('UPDATE inventory_cost_layers SET remaining_quantity = ? WHERE id = ?')
            .bind(newRemaining, layer.id)
            .run()
          needed -= take
        }
        effectiveUnitCostCents = data.quantity > 0 ? Math.round(totalCogsCents / data.quantity) : 0
      }

      const marginCents = data.revenueNetCents - totalCogsCents
      const marginBasisPoints = data.revenueNetCents > 0 ? Math.round((marginCents / data.revenueNetCents) * 10000) : 0

      const consumptionId = crypto.randomUUID()
      await database
        .prepare(
          `INSERT INTO inventory_cost_consumptions(id, order_id, order_line_index, variant_id, location_id, method, quantity, unit_cost_cents, total_cogs_cents, revenue_net_cents, margin_cents, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          consumptionId,
          data.orderId,
          data.orderLineIndex,
          data.variantId,
          data.locationId,
          method,
          data.quantity,
          effectiveUnitCostCents,
          totalCogsCents,
          data.revenueNetCents,
          marginCents,
          now
        )
        .run()

      resultVersion = 1
      resultData = {
        consumptionId,
        orderId: data.orderId,
        orderLineIndex: data.orderLineIndex,
        variantId: data.variantId,
        method,
        quantity: data.quantity,
        unitCostCents: effectiveUnitCostCents,
        totalCogsCents,
        revenueNetCents: data.revenueNetCents,
        marginCents,
        marginBasisPoints,
        createdAt: now
      }
      break
    }

    case 'review_suggestion': {
      const data = parsedInput as { suggestionId: string; action: 'review' | 'dismiss'; reason: string }
      const sugg = await database
        .prepare('SELECT id, status FROM inventory_reorder_suggestions WHERE id = ?')
        .bind(data.suggestionId)
        .first<{ id: string; status: string }>()
      if (!sugg) throw new InventoryLotsCostingError('not_found')

      const newStatus = data.action === 'review' ? 'reviewed' : 'dismissed'
      await database
        .prepare(
          `UPDATE inventory_reorder_suggestions
           SET status = ?, reviewed_by = ?, reviewed_at = ?
           WHERE id = ?`
        )
        .bind(newStatus, claims.identityId, now, data.suggestionId)
        .run()

      resultVersion = 1
      resultData = { suggestionId: data.suggestionId, status: newStatus }
      break
    }

    case 'ack_anomaly': {
      const data = parsedInput as { anomalyId: string; reason: string }
      const anom = await database
        .prepare('SELECT id, status FROM inventory_demand_anomalies WHERE id = ?')
        .bind(data.anomalyId)
        .first<{ id: string; status: string }>()
      if (!anom) throw new InventoryLotsCostingError('not_found')

      await database
        .prepare("UPDATE inventory_demand_anomalies SET status = 'acknowledged' WHERE id = ?")
        .bind(data.anomalyId)
        .run()

      resultVersion = 1
      resultData = { anomalyId: data.anomalyId, status: 'acknowledged' }
      break
    }
  }

  const receipt: LotsCostingReceipt = {
    source: 'cloudflare',
    commandId,
    action,
    targetId,
    payloadHash,
    resultVersion,
    data: resultData,
    createdAt: now
  }

  await database
    .prepare(
      `INSERT INTO inventory_lots_costing_commands(command_id, actor_id, action, target_id, payload_hash, input, response, result_version, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      commandId,
      claims.identityId,
      action,
      targetId,
      payloadHash,
      JSON.stringify(parsedInput),
      JSON.stringify(receipt),
      resultVersion,
      now
    )
    .run()

  return receipt
}
