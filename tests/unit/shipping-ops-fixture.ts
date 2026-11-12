import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { testUuid } from '../support/deterministic'

export const NOW = '2026-10-29T10:00:00Z'
export const ADMIN = 'admin-1'
export const OTHER = 'user-2'
export const DRIVER_IDENTITY = 'drv-ident-1'
export const DRIVER_IDENTITY_2 = 'drv-ident-2'

export interface OpsWorld {
  sqlite: DatabaseSync
  db: D1Database
  close: () => void
}

/** Real SQLite with base + 0069 packing + 0109 routes + 0129 migrations. FK checks off so order rows can stay minimal. */
export async function opsWorld(): Promise<OpsWorld> {
  const sqlite = await openMigratedDatabase()
  try {
    for (const file of [
      '0069_order_packing.sql',
      '0109_shipping_convenience_conditions_routes.sql',
      '0129_delivery_app_carrier_manifests_packing_optimizer.sql'
    ])
      sqlite.exec(await readFile(`db/d1/migrations/${file}`, 'utf8'))
    sqlite.exec('PRAGMA foreign_keys = OFF')
    const identity = (id: string) =>
      `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES('${id}','${id}@example.invalid','syn','${NOW}','active','${NOW}','${NOW}');`
    sqlite.exec(`
      ${[ADMIN, OTHER, DRIVER_IDENTITY, DRIVER_IDENTITY_2].map(identity).join('\n')}
      INSERT INTO roles(code,name,description) VALUES('admin-role','Admin','Synthetic');
      INSERT INTO permissions(code,resource,action,description) VALUES('administration.manage','administration','manage','Synthetic');
      INSERT INTO role_permissions(role_code,permission_code) VALUES('admin-role','administration.manage');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ADMIN}','admin-role','${NOW}');
    `)
    return { sqlite, db: d1OverSqlite(sqlite), close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

export interface SeedShipment {
  carrier: string
  trackingNumber: string
  shipmentNumber?: string
  weightGrams?: number
}

/** Inserts a real order_packings projection (command + projection) with a manual dispatch, as the packing worker would. */
export function seedDispatchedOrder(sqlite: DatabaseSync, orderId: string, shipments: SeedShipment[]) {
  const parcels = shipments.map((s, i) => ({
    weightGrams: s.weightGrams ?? 1000 + i,
    widthMm: 100,
    heightMm: 100,
    depthMm: 100,
    contents: [{ lineIndex: 0, quantity: 1 }]
  }))
  const dispatch = {
    commandId: testUuid(),
    packingVersion: 1,
    shipments: shipments.map((s, i) => ({
      parcelIndex: i,
      carrier: s.carrier,
      shipmentNumber: s.shipmentNumber ?? `SHIP-${s.trackingNumber}`,
      trackingNumber: s.trackingNumber,
      externalLabelReference: `ref-${s.trackingNumber}`
    })),
    actualNetCents: 500,
    taxBps: 2100,
    actualTaxCents: 105,
    actualGrossCents: 605,
    quotedGrossCents: 600,
    varianceGrossCents: 5,
    recordedAt: NOW,
    labelVerification: 'unverified_reference_only'
  }
  const commandId = testUuid()
  sqlite
    .prepare(
      `INSERT INTO order_packing_commands(command_id,claim_nonce,actor_id,order_id,action,payload_hash,input,expected_version,result_version,fulfillment_version,source_snapshot,parcels,dispatch,response,created_at)
       VALUES(?,?,?,?,'manual_dispatch',?,'{}',0,1,1,'{}',?,?,'{}',?)`
    )
    .run(commandId, testUuid(), ADMIN, orderId, 'a'.repeat(64), JSON.stringify(parcels), JSON.stringify(dispatch), NOW)
  sqlite
    .prepare(
      `INSERT INTO order_packings(order_id,version,state,parcels,dispatch,last_command_id,updated_at) VALUES(?,1,'manual_dispatch_recorded',?,?,?,?)`
    )
    .run(orderId, JSON.stringify(parcels), JSON.stringify(dispatch), commandId, NOW)
}

/** Test-only: force an order_fulfillments status (its projection triggers are owned by another module). */
export function setFulfillmentStatus(sqlite: DatabaseSync, orderId: string, status: string) {
  sqlite.exec('DROP TRIGGER IF EXISTS order_fulfillments_insert; DROP TRIGGER IF EXISTS order_fulfillments_update;')
  sqlite.exec(`DELETE FROM order_fulfillments WHERE order_id = '${orderId}'`)
  const interrupted = status === 'exception' ? "'packed'" : 'NULL'
  sqlite.exec(
    `INSERT INTO order_fulfillments(order_id,location_id,status,interrupted_state,version,last_command_id,created_at,updated_at)
     VALUES('${orderId}','loc','${status}',${interrupted},1,'cmd-${orderId}','${NOW}','${NOW}')`
  )
}
