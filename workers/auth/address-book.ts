import { validateCloudflareCustomerAddress } from '../../shared/customer-tax-validation'
import type { AddressInput } from '../../server/domain/customer'
import { verifySessionCookie } from './session-cookie'
import type { SessionCookieConfiguration } from './session-cookie'

export type CustomerAddressInput = AddressInput
export type AddressWriteResult =
  { ok: true; id: string } | { ok: false; code: 'unauthenticated' | 'not_found' | 'address_limit' }

const activeCustomerSql = `SELECT i.customer_id FROM auth_sessions s
JOIN identities i ON i.id = s.identity_id AND i.session_version = s.session_version
JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
WHERE s.id = ? AND s.identity_id = ? AND s.session_version = ?
  AND i.status IN ('pending', 'active') AND s.revoked_at IS NULL
  AND s.created_at <= ? AND s.expires_at > ?`

const addressColumns = `id, kind, label, recipient_name AS recipientName,
company_name AS companyName, tax_id AS taxId, line1, line2,
postal_code AS postalCode, city, region, country_code AS countryCode,
phone, instructions, is_default AS isDefault, created_at AS createdAt, updated_at AS updatedAt`

type AddressRow = {
  id: string
  kind: 'shipping' | 'billing' | 'both'
  label: string
  recipientName: string
  companyName: string | null
  taxId: string | null
  line1: string
  line2: string | null
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone: string | null
  instructions: string | null
  isDefault: number
  createdAt: string
  updatedAt: string
}

function canonicalNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function addressFields(input: CustomerAddressInput) {
  const value = validateCloudflareCustomerAddress(input)
  return [
    value.kind,
    value.label,
    value.recipientName,
    value.companyName || null,
    value.taxId || null,
    value.line1,
    value.line2 || null,
    value.postalCode.toUpperCase(),
    value.city,
    value.region,
    value.countryCode,
    value.phone || null,
    value.instructions || null,
    Number(value.isDefault)
  ] as const
}

async function activeClaims(request: Request, configuration: SessionCookieConfiguration) {
  const claims = await verifySessionCookie(request, configuration)
  if (!claims) return null
  const now = canonicalNow()
  return { binds: [claims.sessionId, claims.identityId, claims.sessionVersion, now, now] as const, now }
}

async function hasActiveCustomer(database: D1Database, binds: readonly (string | number)[]) {
  return Boolean(
    await database
      .prepare(activeCustomerSql)
      .bind(...binds)
      .first<{ customer_id: string }>()
  )
}

/** Every read and mutation resolves ownership from the still-live D1 session. */
export async function listD1CustomerAddresses(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration
) {
  const active = await activeClaims(request, configuration)
  if (!active || !(await hasActiveCustomer(database, active.binds))) return null
  const rows = await database
    .prepare(
      `SELECT ${addressColumns} FROM customer_addresses
      WHERE customer_id = (${activeCustomerSql}) ORDER BY is_default DESC, created_at DESC, id DESC`
    )
    .bind(...active.binds)
    .all<AddressRow>()
  return rows.results.map((row) => ({ ...row, isDefault: Boolean(row.isDefault) }))
}

export async function createD1CustomerAddress(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  input: CustomerAddressInput
): Promise<AddressWriteResult> {
  const active = await activeClaims(request, configuration)
  if (!active) return { ok: false, code: 'unauthenticated' }
  const id = crypto.randomUUID()
  const inserted = await database
    .prepare(
      `INSERT INTO customer_addresses (
        id, customer_id, kind, label, recipient_name, company_name, tax_id, line1, line2,
        postal_code, city, region, country_code, phone, instructions, is_default, created_at, updated_at
      ) SELECT ?, owner.customer_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM (${activeCustomerSql}) owner
        WHERE (SELECT count(*) FROM customer_addresses a WHERE a.customer_id = owner.customer_id) < 50
        RETURNING id`
    )
    .bind(id, ...addressFields(input), active.now, active.now, ...active.binds)
    .first<{ id: string }>()
  if (inserted) return { ok: true, id: inserted.id }
  return (await hasActiveCustomer(database, active.binds))
    ? { ok: false, code: 'address_limit' }
    : { ok: false, code: 'unauthenticated' }
}

export async function updateD1CustomerAddress(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  id: string,
  input: CustomerAddressInput
): Promise<AddressWriteResult> {
  const active = await activeClaims(request, configuration)
  if (!active) return { ok: false, code: 'unauthenticated' }
  const updated = await database
    .prepare(
      `UPDATE customer_addresses SET kind = ?, label = ?, recipient_name = ?,
        company_name = ?, tax_id = ?, line1 = ?, line2 = ?, postal_code = ?, city = ?, region = ?,
        country_code = ?, phone = ?, instructions = ?, is_default = ?, updated_at = ?
      WHERE id = ? AND customer_id = (${activeCustomerSql}) RETURNING id`
    )
    .bind(...addressFields(input), active.now, id, ...active.binds)
    .first<{ id: string }>()
  if (updated) return { ok: true, id: updated.id }
  return (await hasActiveCustomer(database, active.binds))
    ? { ok: false, code: 'not_found' }
    : { ok: false, code: 'unauthenticated' }
}

export async function deleteD1CustomerAddress(
  database: D1Database,
  request: Request,
  configuration: SessionCookieConfiguration,
  id: string
): Promise<AddressWriteResult> {
  const active = await activeClaims(request, configuration)
  if (!active) return { ok: false, code: 'unauthenticated' }
  const deleted = await database
    .prepare(`DELETE FROM customer_addresses WHERE id = ? AND customer_id = (${activeCustomerSql}) RETURNING id`)
    .bind(id, ...active.binds)
    .first<{ id: string }>()
  if (deleted) return { ok: true, id: deleted.id }
  return (await hasActiveCustomer(database, active.binds))
    ? { ok: false, code: 'not_found' }
    : { ok: false, code: 'unauthenticated' }
}
