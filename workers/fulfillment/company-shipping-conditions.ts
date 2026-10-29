import { createHash, randomUUID } from 'node:crypto'
import type { CompanyShippingConditions, CompanyShippingMethodCode } from '../../shared/company-shipping-conditions'
import type { DatabaseAdapter } from './convenience-points'

export class CompanyShippingConditionsError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_found' | 'version_conflict' | 'unauthorized' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'CompanyShippingConditionsError'
  }
}

export interface SetCompanyShippingConditionsCommandInput {
  actorId: string
  companyId: string
  allowedMethods: CompanyShippingMethodCode[]
  customMethodsEnabled?: boolean
  carrierAccountCarrier?: string | null
  carrierAccountNumber?: string | null
  warehousePickupAllowed?: boolean
  freeShippingThresholdCents?: number | null
  customDeliveryInstructions?: string | null
  expectedVersion: number
  commandId: string
  now?: string
}

interface RawConditionRow {
  company_id: string
  custom_methods_enabled: number
  allowed_methods_json: string
  carrier_account_carrier: string | null
  carrier_account_number: string | null
  warehouse_pickup_allowed: number
  free_shipping_threshold_cents: number | null
  custom_delivery_instructions: string | null
  version: number
  created_at: string
  updated_at: string
}

function mapRow(row: RawConditionRow): CompanyShippingConditions {
  let allowedMethods: CompanyShippingMethodCode[]
  try {
    allowedMethods = JSON.parse(row.allowed_methods_json) as CompanyShippingMethodCode[]
  } catch {
    allowedMethods = ['pickup', 'own_delivery', 'parcel']
  }

  return {
    companyId: row.company_id,
    customMethodsEnabled: row.custom_methods_enabled === 1,
    allowedMethods,
    carrierAccountCarrier: row.carrier_account_carrier,
    carrierAccountNumber: row.carrier_account_number,
    warehousePickupAllowed: row.warehouse_pickup_allowed === 1,
    freeShippingThresholdCents: row.free_shipping_threshold_cents,
    customDeliveryInstructions: row.custom_delivery_instructions,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

async function executeGet<T>(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<T | null> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
    }
    if (typeof stmt.first === 'function') {
      const res = await stmt.first(...params)
      return (res as T) ?? null
    }
    if (typeof stmt.get === 'function') {
      const res = await stmt.get(...params)
      return (res as T) ?? null
    }
  }
  return null
}

async function executeRun(db: DatabaseAdapter, sql: string, params: unknown[]): Promise<void> {
  if (typeof db.prepare === 'function') {
    let stmt = db.prepare(sql)
    if (typeof stmt.bind === 'function' && params.length > 0) {
      stmt = stmt.bind(...params) as typeof stmt
    }
    if (typeof stmt.run === 'function') {
      await stmt.run(...params)
    }
  }
}

export async function getCompanyShippingConditions(
  db: DatabaseAdapter,
  companyId: string
): Promise<CompanyShippingConditions | null> {
  const sql = `
    SELECT company_id, custom_methods_enabled, allowed_methods_json, carrier_account_carrier,
           carrier_account_number, warehouse_pickup_allowed, free_shipping_threshold_cents,
           custom_delivery_instructions, version, created_at, updated_at
    FROM company_shipping_conditions
    WHERE company_id = ?
    LIMIT 1
  `
  const row = await executeGet<RawConditionRow>(db, sql, [companyId])
  return row ? mapRow(row) : null
}

export async function setCompanyShippingConditions(
  db: DatabaseAdapter,
  input: SetCompanyShippingConditionsCommandInput
): Promise<CompanyShippingConditions> {
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Validation
  if (!input.companyId || typeof input.companyId !== 'string') {
    throw new CompanyShippingConditionsError('invalid_input', 'Invalid companyId')
  }
  if (!Array.isArray(input.allowedMethods) || input.allowedMethods.length === 0) {
    throw new CompanyShippingConditionsError('invalid_input', 'At least one allowedMethod is required')
  }

  if (input.allowedMethods.includes('carrier_customer_account')) {
    if (!input.carrierAccountCarrier || !input.carrierAccountNumber) {
      throw new CompanyShippingConditionsError(
        'invalid_input',
        'carrierAccountCarrier and carrierAccountNumber are required when carrier_customer_account is enabled'
      )
    }
  }

  // Idempotency check: see if command_id was already executed for this company
  const existingCommand = await executeGet<{ command_id: string; applied_version: number }>(
    db,
    `SELECT command_id, applied_version FROM company_shipping_condition_commands WHERE company_id = ? AND command_id = ?`,
    [input.companyId, input.commandId]
  )
  if (existingCommand) {
    const existing = await getCompanyShippingConditions(db, input.companyId)
    if (existing) return existing
  }

  // CAS check
  const current = await getCompanyShippingConditions(db, input.companyId)
  const currentVersion = current ? current.version : 0
  if (input.expectedVersion !== currentVersion) {
    throw new CompanyShippingConditionsError(
      'version_conflict',
      `Version conflict: expected ${input.expectedVersion}, but current is ${currentVersion}`
    )
  }

  const nextVersion = currentVersion + 1
  const customMethodsEnabled = input.customMethodsEnabled !== false ? 1 : 0
  const allowedMethodsJson = JSON.stringify(input.allowedMethods)
  const warehousePickupAllowed = input.warehousePickupAllowed !== false ? 1 : 0
  const carrierAccountCarrier = input.carrierAccountCarrier ?? null
  const carrierAccountNumber = input.carrierAccountNumber ?? null
  const freeShippingThresholdCents =
    input.freeShippingThresholdCents !== undefined && input.freeShippingThresholdCents !== null
      ? input.freeShippingThresholdCents
      : null
  const customDeliveryInstructions = input.customDeliveryInstructions ?? null

  const payload = {
    companyId: input.companyId,
    allowedMethods: input.allowedMethods,
    customMethodsEnabled,
    carrierAccountCarrier,
    carrierAccountNumber,
    warehousePickupAllowed,
    freeShippingThresholdCents,
    customDeliveryInstructions,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId
  }
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  const commandRecordId = randomUUID()

  await executeRun(
    db,
    `INSERT INTO company_shipping_condition_commands (
       id, company_id, actor_id, command_id, expected_version, applied_version, payload_hash, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      commandRecordId,
      input.companyId,
      input.actorId,
      input.commandId,
      input.expectedVersion,
      nextVersion,
      payloadHash,
      JSON.stringify(payload),
      now
    ]
  )

  if (current) {
    await executeRun(
      db,
      `UPDATE company_shipping_conditions
       SET custom_methods_enabled = ?,
           allowed_methods_json = ?,
           carrier_account_carrier = ?,
           carrier_account_number = ?,
           warehouse_pickup_allowed = ?,
           free_shipping_threshold_cents = ?,
           custom_delivery_instructions = ?,
           version = ?,
           updated_at = ?
       WHERE company_id = ?`,
      [
        customMethodsEnabled,
        allowedMethodsJson,
        carrierAccountCarrier,
        carrierAccountNumber,
        warehousePickupAllowed,
        freeShippingThresholdCents,
        customDeliveryInstructions,
        nextVersion,
        now,
        input.companyId
      ]
    )
  } else {
    await executeRun(
      db,
      `INSERT INTO company_shipping_conditions (
         company_id, custom_methods_enabled, allowed_methods_json, carrier_account_carrier,
         carrier_account_number, warehouse_pickup_allowed, free_shipping_threshold_cents,
         custom_delivery_instructions, version, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.companyId,
        customMethodsEnabled,
        allowedMethodsJson,
        carrierAccountCarrier,
        carrierAccountNumber,
        warehousePickupAllowed,
        freeShippingThresholdCents,
        customDeliveryInstructions,
        nextVersion,
        now,
        now
      ]
    )
  }

  const updated = await getCompanyShippingConditions(db, input.companyId)
  if (!updated) {
    throw new CompanyShippingConditionsError('internal', 'Failed to retrieve updated shipping conditions')
  }
  return updated
}
