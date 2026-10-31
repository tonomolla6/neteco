import type {
  CustomerSplitPreferences,
  CustomerSplitPreferencesInput,
  OrderSplitBillingSummary,
  SplitBillingReconciliationInput,
  SplitBillingReconciliationRecord,
  SplitShipment,
  SplitShipmentInput,
  SplitShipmentItem
} from '../../shared/order-split-backorders'

export async function setCustomerSplitPreferences(
  database: D1Database,
  input: CustomerSplitPreferencesInput & { now: string }
): Promise<CustomerSplitPreferences> {
  const existing = await database
    .prepare('SELECT * FROM order_split_shipment_preferences WHERE order_id = ?1')
    .bind(input.orderId)
    .first<{
      version: number
      customer_accepts_split: number
      accepted_extra_shipping_cents: number
      shipping_cost_payer: string
      customer_consent_at: string
      created_at: string
      updated_at: string
    }>()

  if (existing) {
    const nextVersion = existing.version + 1
    await database
      .prepare(
        `
        UPDATE order_split_shipment_preferences
        SET customer_accepts_split = ?1,
            accepted_extra_shipping_cents = ?2,
            shipping_cost_payer = ?3,
            customer_consent_at = ?4,
            customer_id = ?5,
            version = ?6,
            updated_at = ?7
        WHERE order_id = ?8 AND version = ?9
      `
      )
      .bind(
        input.customerAcceptsSplit ? 1 : 0,
        input.acceptedExtraShippingCents ?? 0,
        input.shippingCostPayer ?? 'merchant',
        input.now,
        input.customerId ?? null,
        nextVersion,
        input.now,
        input.orderId,
        existing.version
      )
      .run()
  } else {
    await database
      .prepare(
        `
        INSERT INTO order_split_shipment_preferences (
          order_id, customer_accepts_split, accepted_extra_shipping_cents,
          shipping_cost_payer, customer_consent_at, customer_id, version,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
      `
      )
      .bind(
        input.orderId,
        input.customerAcceptsSplit ? 1 : 0,
        input.acceptedExtraShippingCents ?? 0,
        input.shippingCostPayer ?? 'merchant',
        input.now,
        input.customerId ?? null,
        input.now
      )
      .run()
  }

  const saved = await getCustomerSplitPreferences(database, input.orderId)
  if (!saved) throw new Error('save_preferences_failed')
  return saved
}

export async function getCustomerSplitPreferences(
  database: D1Database,
  orderId: string
): Promise<CustomerSplitPreferences | null> {
  const row = await database
    .prepare('SELECT * FROM order_split_shipment_preferences WHERE order_id = ?1')
    .bind(orderId)
    .first<{
      order_id: string
      customer_accepts_split: number
      accepted_extra_shipping_cents: number
      shipping_cost_payer: 'merchant' | 'customer'
      customer_consent_at: string
      customer_id: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    orderId: row.order_id,
    customerAcceptsSplit: row.customer_accepts_split === 1,
    acceptedExtraShippingCents: row.accepted_extra_shipping_cents,
    shippingCostPayer: row.shipping_cost_payer,
    customerConsentAt: row.customer_consent_at,
    customerId: row.customer_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createOrderSplitShipments(
  database: D1Database,
  input: SplitShipmentInput & { now: string }
): Promise<{ shipments: SplitShipment[] }> {
  // 1. Verify customer accepted split shipments
  const preferences = await getCustomerSplitPreferences(database, input.orderId)
  if (!preferences || !preferences.customerAcceptsSplit) {
    throw new Error('split_not_accepted: Customer has not accepted partial shipments')
  }

  // 2. Load order lines and verify quantities
  const orderLines = await database
    .prepare('SELECT line_index, variant_id, quantity, unit_gross_cents FROM order_lines WHERE order_id = ?1')
    .bind(input.orderId)
    .all<{
      line_index: number
      variant_id: string
      quantity: number
      unit_gross_cents: number
    }>()

  const lineMap = new Map((orderLines.results ?? []).map((l) => [l.line_index, l]))
  const seenLines = new Set<number>()

  for (const alloc of input.allocations) {
    if (seenLines.has(alloc.lineIndex)) {
      throw new Error(`invalid_input: duplicate lineIndex ${alloc.lineIndex}`)
    }
    seenLines.add(alloc.lineIndex)
    const line = lineMap.get(alloc.lineIndex)
    if (!line) {
      throw new Error(`order_line_not_found: lineIndex ${alloc.lineIndex}`)
    }
    if (alloc.quantityToShip + alloc.quantityBackordered !== line.quantity) {
      throw new Error(
        `quantity_mismatch: line ${alloc.lineIndex} requested ${line.quantity}, allocated ${alloc.quantityToShip + alloc.quantityBackordered}`
      )
    }
  }

  // Idempotency check if shipments already exist for this order
  const existingShipments = await getOrderSplitShipments(database, input.orderId)
  if (existingShipments.length > 0) {
    const existingAllocations = new Map<number, { toShip: number; backordered: number }>()
    for (const shipment of existingShipments) {
      for (const item of shipment.items) {
        const prev = existingAllocations.get(item.lineIndex) ?? { toShip: 0, backordered: 0 }
        prev.toShip += item.quantityAllocated
        prev.backordered += item.quantityBackordered
        existingAllocations.set(item.lineIndex, prev)
      }
    }
    const matches =
      existingAllocations.size === input.allocations.length &&
      input.allocations.every((a) => {
        const ex = existingAllocations.get(a.lineIndex)
        return ex !== undefined && ex.toShip === a.quantityToShip && ex.backordered === a.quantityBackordered
      })
    if (matches) {
      return { shipments: existingShipments }
    }
    throw new Error('conflict: split shipments already exist with different allocations')
  }

  // 3. Separate immediate vs backorder shipments
  const immediateItems = input.allocations.filter((a) => a.quantityToShip > 0)
  const backorderItems = input.allocations.filter((a) => a.quantityBackordered > 0)

  const statements: D1PreparedStatement[] = []

  let shipmentNum = 1
  if (immediateItems.length > 0) {
    const shipmentId = crypto.randomUUID()
    statements.push(
      database
        .prepare(
          `
          INSERT INTO order_split_shipments (
            id, order_id, shipment_number, shipment_type, status,
            carrier, version, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'immediate', 'pending', ?4, 1, ?5, ?5)
        `
        )
        .bind(shipmentId, input.orderId, shipmentNum++, input.carrier ?? null, input.now)
    )

    for (const item of immediateItems) {
      const line = lineMap.get(item.lineIndex)!
      statements.push(
        database
          .prepare(
            `
            INSERT INTO order_split_shipment_items (
              id, shipment_id, order_id, line_index, variant_id,
              quantity_requested, quantity_allocated, quantity_backordered,
              unit_gross_cents, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
          `
          )
          .bind(
            crypto.randomUUID(),
            shipmentId,
            input.orderId,
            item.lineIndex,
            line.variant_id,
            line.quantity,
            item.quantityToShip,
            line.unit_gross_cents,
            input.now
          )
      )
    }
  }

  if (backorderItems.length > 0) {
    const shipmentId = crypto.randomUUID()
    statements.push(
      database
        .prepare(
          `
          INSERT INTO order_split_shipments (
            id, order_id, shipment_number, shipment_type, status,
            carrier, estimated_restock_at, version, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'backorder', 'pending', ?4, ?5, 1, ?6, ?6)
        `
        )
        .bind(
          shipmentId,
          input.orderId,
          shipmentNum,
          input.carrier ?? null,
          input.estimatedRestockAt ?? null,
          input.now
        )
    )

    for (const item of backorderItems) {
      const line = lineMap.get(item.lineIndex)!
      statements.push(
        database
          .prepare(
            `
            INSERT INTO order_split_shipment_items (
              id, shipment_id, order_id, line_index, variant_id,
              quantity_requested, quantity_allocated, quantity_backordered,
              unit_gross_cents, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)
          `
          )
          .bind(
            crypto.randomUUID(),
            shipmentId,
            input.orderId,
            item.lineIndex,
            line.variant_id,
            line.quantity,
            item.quantityBackordered,
            line.unit_gross_cents,
            input.now
          )
      )
    }
  }

  if (statements.length > 0) {
    await database.batch(statements)
  }

  const shipments = await getOrderSplitShipments(database, input.orderId)
  return { shipments }
}

export async function getOrderSplitShipments(database: D1Database, orderId: string): Promise<SplitShipment[]> {
  const shipments = await database
    .prepare('SELECT * FROM order_split_shipments WHERE order_id = ?1 ORDER BY shipment_number ASC')
    .bind(orderId)
    .all<{
      id: string
      order_id: string
      shipment_number: number
      shipment_type: 'immediate' | 'backorder'
      status: 'pending' | 'picking' | 'shipped' | 'delivered' | 'cancelled'
      tracking_number: string | null
      carrier: string | null
      estimated_delivery_at: string | null
      estimated_restock_at: string | null
      shipping_cost_cents: number
      shipped_at: string | null
      delivered_at: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  const items = await database
    .prepare('SELECT * FROM order_split_shipment_items WHERE order_id = ?1')
    .bind(orderId)
    .all<{
      id: string
      shipment_id: string
      order_id: string
      line_index: number
      variant_id: string
      quantity_requested: number
      quantity_allocated: number
      quantity_backordered: number
      unit_gross_cents: number
      created_at: string
    }>()

  const itemsByShipment = new Map<string, SplitShipmentItem[]>()
  for (const item of items.results ?? []) {
    const list = itemsByShipment.get(item.shipment_id) ?? []
    list.push({
      id: item.id,
      shipmentId: item.shipment_id,
      orderId: item.order_id,
      lineIndex: item.line_index,
      variantId: item.variant_id,
      quantityRequested: item.quantity_requested,
      quantityAllocated: item.quantity_allocated,
      quantityBackordered: item.quantity_backordered,
      unitGrossCents: item.unit_gross_cents,
      createdAt: item.created_at
    })
    itemsByShipment.set(item.shipment_id, list)
  }

  return (shipments.results ?? []).map((s) => ({
    id: s.id,
    orderId: s.order_id,
    shipmentNumber: s.shipment_number,
    shipmentType: s.shipment_type,
    status: s.status,
    trackingNumber: s.tracking_number,
    carrier: s.carrier,
    estimatedDeliveryAt: s.estimated_delivery_at,
    estimatedRestockAt: s.estimated_restock_at,
    shippingCostCents: s.shipping_cost_cents,
    shippedAt: s.shipped_at,
    deliveredAt: s.delivered_at,
    version: s.version,
    items: itemsByShipment.get(s.id) ?? [],
    createdAt: s.created_at,
    updatedAt: s.updated_at
  }))
}

export async function reconcileSplitBilling(
  database: D1Database,
  input: SplitBillingReconciliationInput & { now: string }
): Promise<SplitBillingReconciliationRecord> {
  if (input.amountNetCents + input.taxCents + input.shippingCents !== input.totalGrossCents) {
    throw new Error('invalid_invoice_totals: net + tax + shipping must equal totalGrossCents')
  }

  const existing = await database
    .prepare('SELECT * FROM order_split_billing_reconciliation WHERE order_id = ?1 AND invoice_number = ?2')
    .bind(input.orderId, input.invoiceNumber)
    .first<{
      id: string
      order_id: string
      shipment_id: string | null
      invoice_number: string
      amount_net_cents: number
      tax_cents: number
      shipping_cents: number
      total_gross_cents: number
      status: 'draft' | 'issued' | 'reconciled' | 'credited'
      reconciled_with_capture: number
      notes: string | null
      created_at: string
    }>()

  if (existing) {
    if (
      existing.amount_net_cents === input.amountNetCents &&
      existing.tax_cents === input.taxCents &&
      existing.shipping_cents === input.shippingCents &&
      existing.total_gross_cents === input.totalGrossCents
    ) {
      return {
        id: existing.id,
        orderId: existing.order_id,
        shipmentId: existing.shipment_id,
        invoiceNumber: existing.invoice_number,
        amountNetCents: existing.amount_net_cents,
        taxCents: existing.tax_cents,
        shippingCents: existing.shipping_cents,
        totalGrossCents: existing.total_gross_cents,
        status: existing.status,
        reconciledWithCapture: existing.reconciled_with_capture === 1,
        notes: existing.notes,
        createdAt: existing.created_at
      }
    }
    throw new Error('conflict: invoice_number already registered with different amounts')
  }

  const id = crypto.randomUUID()
  await database
    .prepare(
      `
      INSERT INTO order_split_billing_reconciliation (
        id, order_id, shipment_id, invoice_number, amount_net_cents,
        tax_cents, shipping_cents, total_gross_cents, status,
        reconciled_with_capture, notes, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reconciled', 1, ?9, ?10)
    `
    )
    .bind(
      id,
      input.orderId,
      input.shipmentId ?? null,
      input.invoiceNumber,
      input.amountNetCents,
      input.taxCents,
      input.shippingCents,
      input.totalGrossCents,
      input.notes ?? null,
      input.now
    )
    .run()

  return {
    id,
    orderId: input.orderId,
    shipmentId: input.shipmentId ?? null,
    invoiceNumber: input.invoiceNumber,
    amountNetCents: input.amountNetCents,
    taxCents: input.taxCents,
    shippingCents: input.shippingCents,
    totalGrossCents: input.totalGrossCents,
    status: 'reconciled',
    reconciledWithCapture: true,
    notes: input.notes ?? null,
    createdAt: input.now
  }
}

export async function getOrderSplitBillingSummary(
  database: D1Database,
  orderId: string
): Promise<OrderSplitBillingSummary> {
  const order = await database
    .prepare('SELECT total_gross_cents FROM orders WHERE id = ?1')
    .bind(orderId)
    .first<{ total_gross_cents: number }>()

  const preferences = await getCustomerSplitPreferences(database, orderId)
  const records = await database
    .prepare('SELECT * FROM order_split_billing_reconciliation WHERE order_id = ?1 ORDER BY created_at ASC')
    .bind(orderId)
    .all<{
      id: string
      order_id: string
      shipment_id: string | null
      invoice_number: string
      amount_net_cents: number
      tax_cents: number
      shipping_cents: number
      total_gross_cents: number
      status: 'draft' | 'issued' | 'reconciled' | 'credited'
      reconciled_with_capture: number
      notes: string | null
      created_at: string
    }>()

  const orderGrossCents = order?.total_gross_cents ?? 0
  const acceptedExtra = preferences?.acceptedExtraShippingCents ?? 0
  const expectedTotalCents = orderGrossCents + acceptedExtra

  const mappedRecords: SplitBillingReconciliationRecord[] = (records.results ?? []).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    shipmentId: r.shipment_id,
    invoiceNumber: r.invoice_number,
    amountNetCents: r.amount_net_cents,
    taxCents: r.tax_cents,
    shippingCents: r.shipping_cents,
    totalGrossCents: r.total_gross_cents,
    status: r.status,
    reconciledWithCapture: r.reconciled_with_capture === 1,
    notes: r.notes,
    createdAt: r.created_at
  }))

  const totalBilledCents = mappedRecords.reduce((sum, r) => sum + r.totalGrossCents, 0)
  const isFullyReconciled = totalBilledCents === expectedTotalCents
  const discrepancyCents = Math.abs(totalBilledCents - expectedTotalCents)

  return {
    orderId,
    orderGrossCents,
    acceptedExtraShippingCents: acceptedExtra,
    expectedTotalCents,
    totalBilledCents,
    isFullyReconciled,
    discrepancyCents,
    records: mappedRecords
  }
}
