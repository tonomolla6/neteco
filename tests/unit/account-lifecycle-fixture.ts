import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite, seedInventoryFixture } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'

export const NOW = '2030-01-02T12:00:00Z',
  BEFORE = '2020-01-01T00:00:00Z'
export const CUSTOMER = deterministicUuid('lifecycle-customer'),
  ACTOR = deterministicUuid('lifecycle-actor'),
  SESSION = deterministicUuid('lifecycle-session'),
  COMPANY = deterministicUuid('lifecycle-company'),
  AGENT = deterministicUuid('lifecycle-agent'),
  AGENT_SESSION = deterministicUuid('lifecycle-agent-session'),
  OTHER_CUSTOMER = deterministicUuid('lifecycle-other-customer'),
  OTHER_ACTOR = deterministicUuid('lifecycle-other-actor'),
  OTHER_SESSION = deterministicUuid('lifecycle-other-session')
export const CLAIMS = { identityId: ACTOR, sessionId: SESSION, sessionVersion: 1 },
  OTHER_CLAIMS = { identityId: OTHER_ACTOR, sessionId: OTHER_SESSION, sessionVersion: 1 },
  AGENT_CLAIMS = { identityId: AGENT, sessionId: AGENT_SESSION, sessionVersion: 1 },
  OPTIONS = { now: () => NOW }
export const TICKET = 'NET-LIFECYCLE-1'
/** Base schema plus only the migrations this module needs (pending ones of other agents are ignored). */
const MIGRATIONS: [string, string][] = [
  ['support_tickets', '0049_support_operations.sql'],
  ['company_admin_review_commands', '0064_company_admin_review.sql'],
  ['customer_account_preferences', '0066_account_preferences.sql'],
  ['preference_center_commands', '0136_account_lifecycle_preference_center_impersonation.sql']
]
export async function lifecycleFixture() {
  const sqlite = await openMigratedDatabase()
  for (const [probe, name] of MIGRATIONS)
    if (!sqlite.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(probe))
      sqlite.exec(await readFile(`db/d1/migrations/${name}`, 'utf8'))
  const world = seedInventoryFixture(sqlite)
  const row = (sql: string) => sqlite.exec(sql)
  for (const [id, name] of [
    [CUSTOMER, 'Cliente sintético'],
    [OTHER_CUSTOMER, 'Otro cliente']
  ] as const)
    row(`INSERT INTO customers(id,name,created_at,updated_at) VALUES('${id}','${name}','${BEFORE}','${BEFORE}')`)
  for (const [id, email, cust, sess] of [
    [ACTOR, 'lifecycle@example.invalid', CUSTOMER, SESSION],
    [OTHER_ACTOR, 'other@example.invalid', OTHER_CUSTOMER, OTHER_SESSION]
  ] as const) {
    row(
      `INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES('${id}','${email}','synthetic','active','${BEFORE}','${cust}','${BEFORE}','${BEFORE}')`
    )
    row(
      `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${sess}','${id}',1,0,'${BEFORE}','2099-01-01T00:00:00Z')`
    )
  }
  row(
    `INSERT INTO companies(id,customer_id,legal_name,tax_id,country_code,status,created_at,updated_at) VALUES('${COMPANY}','${CUSTOMER}','Limpiezas Sintéticas SL','B12345674','ES','pending','${BEFORE}','${BEFORE}')`
  )
  // Support agent with live MFA and the impersonation permission.
  row(
    `INSERT INTO identities(id,email,password_hash,status,email_verified_at,created_at,updated_at) VALUES('${AGENT}','agent@example.invalid','synthetic','active','${BEFORE}','${BEFORE}','${BEFORE}');
 INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${AGENT_SESSION}','${AGENT}',1,1,'${BEFORE}','2099-01-01T00:00:00Z');
 INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES('${AGENT}','synthetic-unused','${BEFORE}','${BEFORE}');
 INSERT INTO roles VALUES('lifecycle-support','Support','Synthetic');
 INSERT OR IGNORE INTO permissions VALUES('support.manage','support','manage','Synthetic'),('support.impersonate','support','impersonate','Synthetic');
 INSERT INTO role_permissions VALUES('lifecycle-support','support.manage');
 INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${AGENT}','lifecycle-support','${BEFORE}')`
  )
  const grantImpersonation = () =>
    row(`INSERT OR IGNORE INTO role_permissions VALUES('lifecycle-support','support.impersonate')`)
  // Synthetic ticket: bypass only the command-proof trigger of the support module under test.
  sqlite.exec(
    'PRAGMA foreign_keys=OFF; DROP TRIGGER support_tickets_proof_insert; DROP TRIGGER support_tickets_proof_update'
  )
  row(
    `INSERT INTO support_tickets(id,public_ref,customer_id,category,subject,requester,state,priority,retention_until,version,last_command_id,created_at,updated_at)
 VALUES('${deterministicUuid('lifecycle-ticket')}','${TICKET}','${CUSTOMER}','account','Ayuda con la cuenta','{}','open','normal','2099-01-01T00:00:00Z',1,'${deterministicUuid('lifecycle-ticket-cmd')}','${BEFORE}','${BEFORE}')`
  )
  sqlite.exec('PRAGMA foreign_keys=ON')
  /** Insert a paid order line history for a variant (FKs disabled for the minimal synthetic row). */
  function paidPurchase(variantId: string, at: string, customerId = CUSTOMER, quantity = 1) {
    const id = deterministicUuid(`order-${variantId}-${at}-${customerId}`)
    sqlite.exec('PRAGMA foreign_keys=OFF')
    sqlite
      .prepare(
        `INSERT INTO orders(id,cart_id,quote_id,shipping_quote_id,attempt_id,token_hash,status,reservation_id,reservation_expires_at,total_net_cents,total_tax_cents,total_gross_cents,shipping_net_cents,shipping_tax_cents,shipping_gross_cents,shipping_method_code,shipping_rate_version,shipping_eta_min_days,shipping_eta_max_days,contact_email,contact_email_hash,consent_tos,consent_privacy,correlation_id,created_at,updated_at,customer_id)
 VALUES(?1,?1,?1,?1,?1,?2,'awaiting_payment','r',?3,500,0,500,0,0,0,'std',1,1,2,'b@example.invalid',?2,1,1,'c',?3,?3,?4)`
      )
      .run(id, id.replaceAll('-', '').padEnd(64, 'a'), at, customerId)
    sqlite
      .prepare(
        `INSERT INTO order_lines(order_id,line_index,variant_id,sku,name,quantity,unit_gross_cents,net_cents,tax_cents,gross_cents,tax_rate_basis_points,price_version_id,location_id,created_at)
 VALUES(?1,0,?2,'SKU','Producto',?3,500,500,0,500,0,'pv',?4,?5)`
      )
      .run(id, variantId, quantity, world.locationId, at)
    sqlite
      .prepare(`INSERT INTO order_payment_states(order_id,status,paid_gross_cents,updated_at) VALUES(?1,'paid',500,?2)`)
      .run(id, at)
    sqlite.exec('PRAGMA foreign_keys=ON')
    return id
  }
  return { sqlite, database: d1OverSqlite(sqlite), world, row, grantImpersonation, paidPurchase }
}
