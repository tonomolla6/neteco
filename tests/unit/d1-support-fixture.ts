import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSupportContactHttp } from '../../workers/support/contact-http'
import { handleAdminSupportHttp } from '../../workers/support/admin-http'
import { handleCustomerSupportHttp } from '../../workers/support/customer-http'
import { createSupportTicket, supportActor, supportClock } from '../../workers/support/operations'
import type { SupportHttpDependencies } from '../../workers/support/http'
import type { SupportPolicy } from '../../shared/support-operations'
import { testUuid } from '../support/deterministic'
export { CLAIMS, BUYER_CLAIMS, utc }
export const ORIGIN = 'https://support.neteco.test'
export const CONTACT = {
  name: 'Synthetic buyer',
  email: 'buyer@example.invalid',
  category: 'order' as const,
  subject: 'Consulta sobre pedido confirmado',
  message: 'Mensaje público inicial de fixture local.',
  privacyAcknowledged: true as const,
  website: '' as const
}
export const POLICY: SupportPolicy = {
  reference: 'explicit-synthetic-policy-not-legal-acceptance',
  version: 1,
  privacyNoticePath: '/privacidad',
  retentionDays: 30,
  responseMinutes: null,
  serviceHoursDescription: null
}
export async function supportFixture() {
  const fixture = await returnsFixture(),
    { sqlite, database } = fixture
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='support_commands'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0049_support_operations.sql', import.meta.url), 'utf8'))
  const order = await fixture.order()
  sqlite.exec(
    "INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic existing permission');" +
      "INSERT INTO role_permissions VALUES('operator','support.manage');" +
      "DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='administration.manage';"
  )
  const configuration = { password: 'synthetic-support-session-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }
  const adminCookie = (await issueD1SessionCookie(database, CLAIMS, configuration))!.split(';')[0]!,
    customerCookie = (await issueD1SessionCookie(database, BUYER_CLAIMS, configuration))!.split(';')[0]!
  const deps: SupportHttpDependencies = {
    database,
    origin: ORIGIN,
    sessionCookieConfiguration: configuration,
    policy: POLICY,
    contactPepper: 'synthetic-support-quota-pepper-0123456789abcdef',
    edgeGate: async () => 'allowed'
  }
  const dispatch = async (request: Request) =>
    (await handleSupportContactHttp(request, deps)) ??
    (await handleAdminSupportHttp(request, deps)) ??
    (await handleCustomerSupportHttp(request, deps)) ??
    new Response(null, { status: 404 })
  const request = (path: string, method = 'GET', body?: unknown, cookie = adminCookie, key = testUuid()) =>
    dispatch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          'cf-connecting-ip': '192.0.2.149',
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )
  const ticket = async (input: unknown = { ...CONTACT, orderId: order }, key = testUuid()) =>
    createSupportTicket(database, await supportActor(database, BUYER_CLAIMS, 'customer', supportClock()), input, {
      idempotencyKey: key,
      policy: POLICY
    })
  const economic = () => ({
    inventory: sqlite.prepare('SELECT * FROM inventory_balances ORDER BY variant_id,location_id').all(),
    movements: sqlite.prepare('SELECT * FROM inventory_movements ORDER BY id').all(),
    orders: sqlite.prepare('SELECT * FROM orders ORDER BY id').all(),
    payments: sqlite.prepare('SELECT * FROM order_payment_states ORDER BY order_id').all(),
    fiscal: sqlite.prepare('SELECT * FROM fiscal_invoice_intents ORDER BY id').all()
  })
  return { ...fixture, order, deps, request, dispatch, ticket, economic, adminCookie, customerCookie }
}
