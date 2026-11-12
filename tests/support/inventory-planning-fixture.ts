import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import {
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  INVENTORY_FIXTURE_VARIANT,
  openAdminInventoryFixture
} from './admin-inventory-fixture'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import { testNow } from './deterministic'

export const PLANNING_VARIANT = INVENTORY_FIXTURE_VARIANT
export const claimsA: VerifiedSessionClaims = {
  identityId: INVENTORY_FIXTURE_ACTOR,
  sessionId: INVENTORY_FIXTURE_SESSION,
  sessionVersion: 1
}
export const claimsB: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000042',
  sessionId: '20000000-0000-4000-8000-000000000042',
  sessionVersion: 1
}
/** Authenticated with MFA but with no inventory role at all. */
export const claimsNoRole: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000043',
  sessionId: '20000000-0000-4000-8000-000000000043',
  sessionVersion: 1
}
export const isoNow = (offsetMs = 0) => new Date(testNow() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
let counter = 0
export const uuid = () => {
  counter++
  return `c0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
}

export async function openPlanningFixture() {
  const { sqlite, database } = await openAdminInventoryFixture()
  sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0140_reorder_barcode_cycle_counts.sql', import.meta.url), 'utf8')
  )
  const stamp = isoNow(-3600000)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?)"
    )
    .run(claimsNoRole.identityId, 'norole@example.invalid', stamp, stamp, stamp)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
    )
    .run(claimsNoRole.sessionId, claimsNoRole.identityId, stamp, isoNow(3600000))
  sqlite.exec(`UPDATE variants SET ean='8437001234567' WHERE id='${PLANNING_VARIANT}'`)
  return { sqlite, database }
}

let seq = 100
/** Adds a synthetic variant with a balance in the single warehouse. */
export function addVariant(
  sqlite: DatabaseSync,
  args: { sku: string; ean?: string | null; physical?: number; blocked?: number; safety?: number }
) {
  seq++
  const id = `40000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
  sqlite
    .prepare(
      `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,ean,format,status,unit_base,price_gross_cents,safety_stock)
       VALUES(?,?,'30000000-0000-4000-8000-000000000041','tax','ship',?,?,'Caja','draft','ud',0,?)`
    )
    .run(id, seq, args.sku, args.ean ?? null, args.safety ?? 0)
  sqlite
    .prepare(
      `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
       VALUES(?, 'main', ?, ?, 1, '2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`
    )
    .run(id, args.physical ?? 0, args.blocked ?? 0)
  return id
}

export function addMovement(
  sqlite: DatabaseSync,
  variantId: string,
  type: 'ship' | 'allocate' | 'receipt',
  delta: number,
  createdAt: string
) {
  const id = uuid()
  sqlite
    .prepare(
      `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at)
       VALUES(?,?, 'main', ?, ?, ?, 'synthetic', ?, ?, ?)`
    )
    .run(id, variantId, type, delta, type === 'allocate' ? delta : 0, id, id, createdAt)
}
