import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { customer360Fixture, CLAIMS, BUYER_CLAIMS, utc } from './customer-360-fixture'
import { readD1Customer360, listD1Customer360 } from '../../workers/support/customer-360'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { testUuid } from '../support/deterministic'
describe('CUS017 canonical role-redacted customer360', () => {
  let f: Awaited<ReturnType<typeof customer360Fixture>>
  beforeEach(async () => {
    f = await customer360Fixture()
  })
  afterEach(() => f.sqlite.close())
  const query = () => ({ ordersPage: 1, ticketsPage: 1, invoicesPage: 1, perPage: 25 })
  it('combines own canonical paid orders, retained incidents, value and explicit next action without mutations', async () => {
    f.fullAccess()
    const before = f.economic()
    const dto = await readD1Customer360(f.database, CLAIMS, f.customerId, query())
    expect(dto.orders).toMatchObject({ visibility: 'visible', data: { total: 1, items: [{ id: f.order }] } })
    expect(dto.tickets).toMatchObject({ visibility: 'visible', data: { items: [{ publicRef: f.publicRef }] } })
    const paid = (
      f.sqlite.prepare('SELECT paid_gross_cents n FROM order_payment_states WHERE order_id=?').get(f.order) as {
        n: number
      }
    ).n
    expect(dto.value).toMatchObject({
      visibility: 'visible',
      data: { paidGrossCents: paid, settledRefundGrossCents: 0, netCollectedGrossCents: paid }
    })
    expect(dto.nextAction).toMatchObject({
      visibility: 'visible',
      data: { ticketRef: f.publicRef, dueAt: f.dueAt, ownerAssigned: true }
    })
    expect(dto.invoices).toMatchObject({ visibility: 'visible', data: { total: 0, items: [] } })
    expect(f.economic()).toEqual(before)
  })
  it('PRI-018: counts an order paid as total minus the store credit applied to it as captured', async () => {
    f.fullAccess()
    const paid = (
      f.sqlite.prepare('SELECT paid_gross_cents n FROM order_payment_states WHERE order_id=?').get(f.order) as {
        n: number
      }
    ).n
    // Simulate the same order having applied 400 cents of store credit at checkout: contractual total
    // 400 higher and the redemption mirrored into the order history by migration 0153.
    f.sqlite.exec('DROP TRIGGER orders_contractual_immutable')
    f.sqlite
      .prepare(
        'UPDATE orders SET total_gross_cents=total_gross_cents+400,total_net_cents=total_net_cents+400 WHERE id=?'
      )
      .run(f.order)
    f.sqlite
      .prepare(
        "INSERT INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at) VALUES('store-credit-ledger:1',?,'store_credit.applied','{\"appliedCents\":400}','credit-cmd',?)"
      )
      .run(f.order, utc(-60000))
    const dto = await readD1Customer360(f.database, CLAIMS, f.customerId, query())
    expect(dto.value).toMatchObject({ visibility: 'visible', data: { paidOrderCount: 1, paidGrossCents: paid } })
  })
  it('redacts every financial and commercial section for support-only grants rather than claiming zero', async () => {
    const dto = await readD1Customer360(f.database, CLAIMS, f.customerId, query())
    for (const section of ['orders', 'invoices', 'value', 'consent'] as const)
      expect(dto[section]).toEqual({ visibility: 'redacted', data: null })
    expect(dto.tickets.visibility).toBe('visible')
    expect(JSON.stringify(dto)).not.toContain('paidGrossCents')
  })
  it('records preference facts but never infers newsletter consent by matching an email', async () => {
    f.fullAccess()
    await updateD1AccountPreferences(f.database, BUYER_CLAIMS, testUuid(), {
      expectedVersion: 0,
      preferences: { product_updates: true, replenishment: false },
      policyVersion: 'communications-2026-10-08'
    })
    const dto = await readD1Customer360(f.database, CLAIMS, f.customerId, query())
    expect(dto.consent).toMatchObject({
      visibility: 'visible',
      data: {
        productUpdates: { value: true, version: 1, basis: 'recorded' },
        replenishment: { value: false, version: 1, basis: 'recorded' },
        deliveryUpdates: { value: true, version: 0, basis: 'default' },
        newsletter: { status: 'unknown', reason: 'identity_unlinked' }
      }
    })
  })
  it('bounds the identifiable picker and rejects unknown query fields', async () => {
    const result = await listD1Customer360(f.database, CLAIMS, { q: 'Historical', page: 1, perPage: 25 })
    expect(result.items).toEqual([{ id: f.customerId, name: 'Historical customer', status: 'active' }])
    expect(JSON.stringify(result)).not.toContain('buyer@example.invalid')
    await expect(listD1Customer360(f.database, CLAIMS, { email: 'buyer@example.invalid' })).rejects.toMatchObject({
      code: 'invalid_input'
    })
    await expect(
      readD1Customer360(f.database, CLAIMS, f.customerId, { ...query(), perPage: 26 })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('includes unnamed active customers in the initial empty search and exact UUID search', async () => {
    const id = testUuid()
    f.sqlite
      .prepare("INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,NULL,'active',?,?)")
      .run(id, utc(-60000), utc(-60000))
    const byId = await listD1Customer360(f.database, CLAIMS, { q: id, page: 1, perPage: 25 })
    expect(byId.items).toEqual([{ id, name: null, status: 'active' }])
    const initial = await listD1Customer360(f.database, CLAIMS, { q: '', page: 1, perPage: 25 })
    expect(initial.items).toContainEqual({ id, name: null, status: 'active' })
    expect(initial.total).toBeGreaterThanOrEqual(byId.total)
    expect(JSON.stringify(initial)).not.toContain('buyer@example.invalid')
  })
  it('does not enrich another customer with this customer orders or next action', async () => {
    f.fullAccess()
    const other = testUuid()
    f.sqlite
      .prepare(
        "INSERT INTO customers(id,name,status,created_at,updated_at) VALUES(?,'Otro cliente sintético','active',?,?)"
      )
      .run(other, utc(-60000), utc(-60000))
    const dto = await readD1Customer360(f.database, CLAIMS, other, query())
    expect(dto.orders).toMatchObject({ visibility: 'visible', data: { total: 0, items: [] } })
    expect(dto.nextAction).toEqual({ visibility: 'visible', data: null })
    expect(JSON.stringify(dto)).not.toContain(f.publicRef)
    expect(JSON.stringify(dto)).not.toContain(f.order)
  })
  it('requires live enrolled MFA and denies customer self-service using the staff namespace', async () => {
    await expect(readD1Customer360(f.database, BUYER_CLAIMS, f.customerId, query())).rejects.toMatchObject({
      code: 'mfa_required'
    })
    f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(CLAIMS.identityId)
    await expect(readD1Customer360(f.database, CLAIMS, f.customerId, query())).rejects.toMatchObject({
      code: 'mfa_required'
    })
  })
  it('revalidates all role sections after reads and rejects revoked authority before releasing data', async () => {
    f.fullAccess()
    let revoked = false
    const db = new Proxy(f.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (!revoked) {
              revoked = true
              f.sqlite.prepare("DELETE FROM role_permissions WHERE role_code='operator'").run()
            }
            return result
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(readD1Customer360(db, CLAIMS, f.customerId, query())).rejects.toMatchObject({ code: 'forbidden' })
    expect(revoked).toBe(true)
  })
  it('excludes expired incident content and does not invent a next action', async () => {
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(40 * 86400000), CLAIMS.sessionId)
    const dto = await readD1Customer360(f.database, CLAIMS, f.customerId, query(), { now: utc(31 * 86400000) })
    expect(dto.tickets).toMatchObject({ visibility: 'visible', data: { total: 0, items: [] } })
    expect(dto.nextAction).toEqual({ visibility: 'visible', data: null })
  })
  it('treats missing required source tables as unavailable, never empty', async () => {
    f.sqlite.exec('DROP TABLE customer_account_preferences')
    f.fullAccess()
    await expect(readD1Customer360(f.database, CLAIMS, f.customerId, query())).rejects.toMatchObject({
      code: 'service_unavailable'
    })
  })
  it('returns no requester, payment provider, fiscal payload, authentication or contact PII', async () => {
    f.fullAccess()
    const dto = JSON.stringify(await readD1Customer360(f.database, CLAIMS, f.customerId, query()))
    for (const secret of [
      'buyer@example.invalid',
      'password_hash',
      'requester',
      'provider_reference',
      'contract_json',
      'recovery_code_hashes',
      BUYER_CLAIMS.identityId,
      BUYER_CLAIMS.sessionId
    ])
      expect(dto).not.toContain(secret)
  })
})
