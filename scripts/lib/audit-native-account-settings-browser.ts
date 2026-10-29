import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chromium, expect, type BrowserContext } from '@playwright/test'
import { z } from 'zod'
import {
  ACCOUNT_PREFERENCES_CONSENT_TEXT,
  ACCOUNT_PREFERENCES_POLICY_VERSION,
  accountPreferencesInputSchema,
  accountPreferencesSnapshotSchema,
  accountPreferencesReceiptSchema,
  accountPreferencesCommandSchema,
  type AccountPreferencesReceipt
} from '../../shared/account-preferences'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION,
  DELIVERY_PREFERENCES_NOTICE_TEXT,
  deliveryPreferencesInputSchema,
  deliveryPreferencesSnapshotSchema,
  deliveryPreferencesReceiptSchema,
  deliveryPreferencesCommandSchema,
  deliveryPreferenceIntentHash,
  type DeliveryPreferencesReceipt
} from '../../shared/delivery-preferences'
import {
  accountPrivacyInputSchema,
  accountPrivacyRequestSchema,
  accountPrivacyResponseSchema,
  accountPrivacyExportSchema,
  type AccountPrivacyRequest
} from '../../shared/account-privacy'
import { canonicalPayloadHash } from '../../workers/catalog/cart'
import { connectRemoteTestBrowser, REMOTE_BROWSER_NOT_RUN_REASON } from './remote-test-browser'
import { sealedSessionCookie } from './audit-browser-session-cookie'

export const ACCOUNT_SETTINGS_BROWSER_SCENARIOS = [
  'native_account_settings_compiled_preferences_receipt_privacy_export_desktop',
  'native_account_settings_compiled_preferences_receipt_privacy_export_mobile'
] as const
export interface AccountSettingsBrowserOwner {
  ownerCookie: string
  customerId: string
  identityId: string
  ownerEmail: string
  /** Synthetic markers belonging to other fixture owners, never production PII. */
  forbiddenValues: readonly string[]
}
export interface NativeAccountSettingsBrowserInput {
  origin: string
  database: D1Database
  dispatch: (request: Request) => Promise<Response>
  prepareOwner: (viewport: 'desktop' | 'mobile') => Promise<AccountSettingsBrowserOwner>
  browserMode?: 'required' | 'not-run'
  scenario?: (name: string) => void
}
type BridgeInput = Omit<NativeAccountSettingsBrowserInput, 'prepareOwner' | 'browserMode' | 'scenario'> &
  AccountSettingsBrowserOwner
type ForwardResult = { action: 'abort'; reason: string } | { action: 'fulfill'; response: Response }
const preferencePath = '/api/account/preferences',
  deliveryPath = '/api/account/delivery-preferences',
  privacyPath = '/api/account/privacy',
  uuid = z.string().uuid(),
  choices = { product_updates: true, replenishment: true }
// Fixed source whitelist only: no caller-supplied SQL, provider calls or authority seeds.
// These scoped digests are not a global no-writes claim; privacy quotas intentionally change.
const unchangedTables = [
  'orders',
  'order_lines',
  'order_payment_states',
  'order_events',
  'inventory_balances',
  'inventory_reservations',
  'inventory_reservation_lines',
  'inventory_movements',
  'payment_commands',
  'payment_intents',
  'payment_events',
  'payment_fulfilment_claims',
  'payment_recovery_jobs',
  'fiscal_outbox_events',
  'fiscal_outbox_delivery',
  'fiscal_invoice_intents',
  'fiscal_provider_receipts',
  'fiscal_documents',
  'refund_contracts',
  'refund_work',
  'refund_receipts',
  'financial_commands',
  'financial_events',
  'fiscal_credit_contracts',
  'fiscal_credit_work',
  'fiscal_credit_receipts',
  'fiscal_credit_documents',
  'email_outbox_events',
  'email_outbox_delivery',
  'email_dispatch_inbox',
  'transactional_email_deliveries',
  'operational_email_suppressions',
  'newsletter_subscriptions',
  'newsletter_consent_events',
  'newsletter_suppressions',
  'newsletter_confirmation_deliveries',
  'newsletter_editorial_preferences',
  'newsletter_editorial_deliveries'
] as const
function isolatedOrigin(origin: string) {
  const url = new URL(origin)
  assert(url.protocol === 'https:' && url.origin === origin && url.hostname === 'shop-audit.neteco.test')
}
function cookieValue(cookie: string) {
  assert(cookie.length <= 16384)
  const match = /^neteco-session=([^;\r\n]+)$/.exec(cookie)
  assert(match, 'Expected isolated signed session cookie')
  return match[1]!
}
async function privateJson(response: Response, status = 200) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.equal(response.headers.has('set-cookie'), false)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i)
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  assert(bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024, 'Bounded real response bytes')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
/** Connect-only browser bridge. Every data/receipt/export byte comes from the caller's
 * real isolated Worker. A proven committed PUT response is deliberately lost once.
 * Direct SELECT witnesses do not replace owner authorization through HTTP. */
export async function createAccountSettingsBrowserBridge(input: BridgeInput) {
  isolatedOrigin(input.origin)
  cookieValue(input.ownerCookie)
  uuid.parse(input.customerId)
  uuid.parse(input.identityId)
  z.string().email().parse(input.ownerEmail)
  assert(input.forbiddenValues.length > 0 && input.forbiddenValues.length <= 20)
  for (const marker of input.forbiddenValues)
    assert(marker.length >= 8 && marker.length <= 256 && marker !== input.ownerEmail)
  async function rows(sql: string, ...parameters: string[]) {
    const result = await input.database
      .prepare(sql)
      .bind(...parameters)
      .all<Record<string, unknown>>()
    assert(result.success && Array.isArray(result.results) && result.results.length <= 10000)
    if (result.meta?.rows_written !== undefined) assert.equal(result.meta.rows_written, 0)
    return result.results.map((row) => ({ ...row }))
  }
  const all = (table: string) => rows(`SELECT * FROM ${table} ORDER BY 1,2 LIMIT 10001`)
  const digest = async () =>
    createHash('sha256')
      .update(JSON.stringify(await Promise.all(unchangedTables.map(all))))
      .digest('hex')
  const baseline = await digest(),
    beforeCommands = await all('account_preference_commands'),
    beforePreferences = await all('customer_account_preferences'),
    beforeDeliveryCommands = await all('delivery_preference_commands'),
    beforeDeliveryPreferences = await all('delivery_preferences'),
    beforePrivacy = await all('account_privacy_requests')
  assert(!beforeCommands.some((r) => r.customer_id === input.customerId))
  assert(!beforePreferences.some((r) => r.customer_id === input.customerId))
  assert(!beforeDeliveryCommands.some((r) => r.customer_id === input.customerId))
  assert(!beforeDeliveryPreferences.some((r) => r.customer_id === input.customerId))
  assert(!beforePrivacy.some((r) => r.customer_id === input.customerId))
  const owners = await rows(
    'SELECT i.email,c.status FROM identities i JOIN customers c ON c.id=i.customer_id WHERE i.id=? AND c.id=?',
    input.identityId,
    input.customerId
  )
  assert.deepEqual(owners, [{ email: input.ownerEmail, status: 'active' }])
  const counters = {
    preferencePuts: 0,
    lostResponses: 0,
    receiptGets: 0,
    currentGets: 0,
    privacyPosts: 0,
    privacyGets: 0,
    downloads: 0,
    recovered: false,
    deliveryPuts: 0,
    deliveryLostResponses: 0,
    deliveryReceiptGets: 0,
    deliveryRecovered: false,
    blockedWrites: 0,
    blockedExternal: 0
  }
  let preferenceClaimed = false,
    deliveryClaimed = false,
    deliveryReceiptRead = false,
    deliveryHash: string | null = null,
    deliveryReceipt: DeliveryPreferencesReceipt | null = null,
    privacyClaimed = false,
    receiptRead = false,
    privacyRead = false,
    preferenceReceipt: AccountPreferencesReceipt | null = null,
    privacyReceipt: AccountPrivacyRequest | null = null
  const serverGet = (path: string, headers: Record<string, string> = {}) =>
    input.dispatch(
      new Request(input.origin + path, {
        headers: { Cookie: input.ownerCookie, Origin: input.origin, 'CF-Connecting-IP': '192.0.2.165', ...headers }
      })
    )
  const abort = (reason: string): ForwardResult => ({ action: 'abort', reason })
  async function forward(request: Request): Promise<ForwardResult> {
    const url = new URL(request.url),
      path = url.pathname
    if (url.origin !== input.origin) {
      counters.blockedExternal++
      return abort('external_request')
    }
    const read = request.method === 'GET' || request.method === 'HEAD'
    const consentDelete = request.method === 'DELETE' && path === '/api/analytics/session' && !url.search
    const preferencePut = request.method === 'PUT' && path === preferencePath
    const deliveryPut = request.method === 'PUT' && path === deliveryPath
    const privacyPost = request.method === 'POST' && path === privacyPath
    if (!read && !consentDelete && !preferencePut && !deliveryPut && !privacyPost) {
      counters.blockedWrites++
      return abort('unapproved_write')
    }
    if (preferencePut || deliveryPut || privacyPost) {
      const key = request.headers.get('idempotency-key')
      const raw = await request.clone().text()
      if (
        url.search ||
        sealedSessionCookie(request.headers.get('cookie')) !== input.ownerCookie ||
        request.headers.get('origin') !== input.origin ||
        !uuid.safeParse(key).success ||
        new TextEncoder().encode(raw).byteLength > 2048
      ) {
        counters.blockedWrites++
        return abort('invalid_frozen_intention')
      }
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        counters.blockedWrites++
        return abort('invalid_body')
      }
      if (deliveryPut) {
        const parsed = deliveryPreferencesInputSchema.safeParse(value)
        if (deliveryClaimed || !parsed.success || parsed.data.expectedVersion !== 0 || parsed.data.deliveryUpdates) {
          counters.blockedWrites++
          return abort('invalid_delivery_intention')
        }
        deliveryClaimed = true
        counters.deliveryPuts++
        const response = await input.dispatch(request)
        if (response.status !== 200) return { action: 'fulfill', response }
        const receipt = deliveryPreferencesReceiptSchema.parse(await privateJson(response))
        assert.equal(receipt.commandId, key)
        assert.equal(receipt.expectedVersion, 0)
        assert.equal(receipt.version, 1)
        assert.equal(receipt.deliveryUpdates, false)
        assert.equal(
          receipt.textHash,
          await canonicalPayloadHash({
            policyVersion: DELIVERY_PREFERENCES_POLICY_VERSION,
            noticeText: DELIVERY_PREFERENCES_NOTICE_TEXT,
            deliveryUpdates: false
          })
        )
        deliveryHash = await deliveryPreferenceIntentHash(parsed.data)
        const command = deliveryPreferencesCommandSchema.parse(
          await privateJson(
            await serverGet(deliveryPath + '/commands/' + key, { 'X-Neteco-Command-Payload-Hash': deliveryHash })
          )
        )
        assert.equal(command.outcome, 'applied')
        assert.deepEqual(command.receipt, receipt)
        const committed = await rows(
          'SELECT * FROM delivery_preference_commands WHERE customer_id=? AND command_id=?',
          input.customerId,
          key!
        )
        assert.equal(committed.length, 1)
        assert.equal(committed[0]!.actor_id, input.identityId)
        assert.equal(committed[0]!.payload_hash, deliveryHash)
        assert.equal(committed[0]!.text_hash, receipt.textHash)
        assert.equal(committed[0]!.policy_version, receipt.policyVersion)
        const current = deliveryPreferencesSnapshotSchema.parse(await privateJson(await serverGet(deliveryPath)))
        assert.equal(current.version, receipt.version)
        assert.equal(current.deliveryUpdates, false)
        assert.equal(current.updatedAt, receipt.recordedAt)
        assert.deepEqual(
          await rows(
            'SELECT version,delivery_updates,updated_at,command_id FROM delivery_preferences WHERE customer_id=?',
            input.customerId
          ),
          [{ version: 1, delivery_updates: 0, updated_at: receipt.recordedAt, command_id: key }]
        )
        deliveryReceipt = receipt
        counters.deliveryLostResponses++
        return abort('proven_delivery_preference_response_lost')
      }
      if (preferencePut) {
        const parsed = accountPreferencesInputSchema.safeParse(value)
        if (
          preferenceClaimed ||
          !parsed.success ||
          parsed.data.expectedVersion !== 0 ||
          !parsed.data.preferences.product_updates ||
          !parsed.data.preferences.replenishment
        ) {
          counters.blockedWrites++
          return abort('invalid_preference_intention')
        }
        preferenceClaimed = true
        counters.preferencePuts++
        const response = await input.dispatch(request)
        if (response.status !== 200) return { action: 'fulfill', response }
        const receipt = accountPreferencesReceiptSchema.parse(await privateJson(response))
        assert.equal(receipt.commandId, key)
        assert.equal(receipt.expectedVersion, 0)
        assert.equal(receipt.version, 1)
        assert.deepEqual(receipt.preferences, choices)
        const textHash = await canonicalPayloadHash({
          policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION,
          consentText: ACCOUNT_PREFERENCES_CONSENT_TEXT,
          preferences: choices
        })
        assert.equal(receipt.textHash, textHash)
        const command = accountPreferencesCommandSchema.parse(
          await privateJson(await serverGet(preferencePath + '/commands/' + key))
        )
        assert.equal(command.outcome, 'applied')
        assert.deepEqual(command.receipt, receipt)
        const committed = await rows(
          'SELECT * FROM account_preference_commands WHERE customer_id=? AND command_id=?',
          input.customerId,
          key!
        )
        assert.equal(committed.length, 1)
        assert.equal(committed[0]!.actor_id, input.identityId)
        assert.equal(committed[0]!.text_hash, textHash)
        assert.equal(committed[0]!.policy_version, ACCOUNT_PREFERENCES_POLICY_VERSION)
        assert.equal(
          committed[0]!.payload_hash,
          await canonicalPayloadHash({ customerId: input.customerId, actorId: input.identityId, ...parsed.data })
        )
        const current = accountPreferencesSnapshotSchema.parse(await privateJson(await serverGet(preferencePath)))
        assert.equal(current.version, receipt.version)
        assert.equal(current.updatedAt, receipt.recordedAt)
        assert.deepEqual(current.preferences, choices)
        const persisted = await rows(
          'SELECT version,product_updates,replenishment,updated_at,command_id FROM customer_account_preferences WHERE customer_id=?',
          input.customerId
        )
        assert.deepEqual(persisted, [
          { version: 1, product_updates: 1, replenishment: 1, updated_at: receipt.recordedAt, command_id: key }
        ])
        preferenceReceipt = receipt
        counters.lostResponses++
        return abort('proven_preference_response_lost')
      }
      const parsed = accountPrivacyInputSchema.safeParse(value)
      if (
        privacyClaimed ||
        !counters.recovered ||
        !counters.deliveryRecovered ||
        !parsed.success ||
        parsed.data.requestType !== 'export' ||
        parsed.data.idempotencyKey !== key
      ) {
        counters.blockedWrites++
        return abort('invalid_privacy_intention')
      }
      privacyClaimed = true
      counters.privacyPosts++
      const response = await input.dispatch(request)
      if (response.status === 202) {
        privacyReceipt = accountPrivacyRequestSchema.parse(await privateJson(response, 202))
        assert.equal(privacyReceipt.commandId, key)
        assert.equal(privacyReceipt.requestType, 'export')
        assert.equal(privacyReceipt.status, 'completed')
      }
      return { action: 'fulfill', response }
    }
    if (
      path.startsWith(deliveryPath + '/commands/') &&
      (!deliveryReceipt ||
        path !== deliveryPath + '/commands/' + deliveryReceipt.commandId ||
        url.search ||
        request.headers.get('X-Neteco-Command-Payload-Hash') !== deliveryHash)
    )
      return abort('invalid_delivery_receipt_intention')
    const response = await input.dispatch(request)
    if (request.method === 'GET' && response.status === 200) {
      if (path === deliveryPath && !url.search) {
        const current = deliveryPreferencesSnapshotSchema.parse(await privateJson(response))
        if (!deliveryReceipt) {
          assert.equal(current.version, 0)
          assert.equal(current.deliveryUpdates, true)
        } else if (deliveryReceiptRead) {
          assert.equal(current.version, deliveryReceipt.version)
          assert.equal(current.deliveryUpdates, false)
          assert.equal(current.updatedAt, deliveryReceipt.recordedAt)
          counters.deliveryRecovered = true
        }
      } else if (deliveryReceipt && path === deliveryPath + '/commands/' + deliveryReceipt.commandId && !url.search) {
        const command = deliveryPreferencesCommandSchema.parse(await privateJson(response))
        assert.equal(command.outcome, 'applied')
        assert.deepEqual(command.receipt, deliveryReceipt)
        deliveryReceiptRead = true
        counters.deliveryReceiptGets++
      } else if (path === preferencePath && !url.search) {
        const current = accountPreferencesSnapshotSchema.parse(await privateJson(response))
        counters.currentGets++
        if (!preferenceReceipt) {
          assert.equal(current.version, 0)
          assert.deepEqual(current.preferences, { product_updates: false, replenishment: false })
        } else if (receiptRead) {
          assert.equal(current.version, preferenceReceipt.version)
          assert.equal(current.updatedAt, preferenceReceipt.recordedAt)
          assert.deepEqual(current.preferences, choices)
          counters.recovered = true
        }
      } else if (
        preferenceReceipt &&
        path === preferencePath + '/commands/' + preferenceReceipt.commandId &&
        !url.search
      ) {
        const command = accountPreferencesCommandSchema.parse(await privateJson(response))
        assert.equal(command.outcome, 'applied')
        assert.deepEqual(command.receipt, preferenceReceipt)
        receiptRead = true
        counters.receiptGets++
      } else if (path === privacyPath && !url.search) {
        const current = accountPrivacyResponseSchema.parse(await privateJson(response))
        counters.privacyGets++
        if (privacyReceipt) {
          assert.deepEqual(
            current.requests.find((r) => r.id === privacyReceipt!.id),
            privacyReceipt
          )
          privacyRead = true
        } else assert.equal(current.requests.length, 0)
      } else if (privacyReceipt && path === `${privacyPath}/${privacyReceipt.id}/download` && !url.search) {
        assert(counters.recovered && privacyRead, 'Fresh authorized privacy list must precede download')
        assert.equal(
          response.headers.get('content-disposition'),
          `attachment; filename="neteco-datos-${privacyReceipt.id}.json"`
        )
        const exported = accountPrivacyExportSchema.parse(await privateJson(response))
        assert.equal(exported.profile.email, input.ownerEmail)
        const securityNotices = await rows(
          'SELECT kind,recipient,audience,created_at AS createdAt FROM identity_account_security_events WHERE identity_id=? ORDER BY created_at,id LIMIT 1001',
          input.identityId
        )
        assert(securityNotices.length <= 1000, 'Bounded own security notice export')
        assert.deepEqual(
          exported.securityNotices,
          securityNotices,
          'Only exact historical notices of the authorized identity may be exported'
        )
        assert.deepEqual(exported.accountPreferences, {
          version: 1,
          ...choices,
          updatedAt: preferenceReceipt!.recordedAt
        })
        assert.deepEqual(exported.deliveryPreferences, {
          version: 1,
          deliveryUpdates: false,
          updatedAt: deliveryReceipt!.recordedAt
        })
        const bytes = JSON.stringify(exported)
        for (const marker of [...input.forbiddenValues, input.ownerCookie, cookieValue(input.ownerCookie)])
          assert(!bytes.includes(marker), 'Export must not expose foreign fixture data or credentials')
        counters.downloads++
      }
    }
    return { action: 'fulfill', response }
  }
  async function assertComplete() {
    assert.equal(counters.preferencePuts, 1)
    assert.equal(counters.lostResponses, 1)
    assert.equal(counters.receiptGets, 1)
    assert.equal(counters.recovered, true)
    assert.equal(counters.deliveryPuts, 1)
    assert.equal(counters.deliveryLostResponses, 1)
    assert.equal(counters.deliveryReceiptGets, 1)
    assert.equal(counters.deliveryRecovered, true)
    assert.equal(counters.privacyPosts, 1)
    assert.equal(counters.downloads, 1)
    assert(preferenceReceipt && deliveryReceipt && privacyReceipt)
    assert.equal(await digest(), baseline, 'No sends, newsletter, inventory or money source changes')
    const commands = await all('account_preference_commands'),
      preferences = await all('customer_account_preferences'),
      deliveryCommands = await all('delivery_preference_commands'),
      deliveryPreferences = await all('delivery_preferences'),
      privacy = await all('account_privacy_requests')
    assert.equal(commands.length, beforeCommands.length + 1)
    assert.deepEqual(
      commands.filter((r) => r.customer_id !== input.customerId),
      beforeCommands
    )
    assert.equal(preferences.length, beforePreferences.length + 1)
    assert.deepEqual(
      preferences.filter((r) => r.customer_id !== input.customerId),
      beforePreferences
    )
    assert.equal(deliveryCommands.length, beforeDeliveryCommands.length + 1)
    assert.deepEqual(
      deliveryCommands.filter((r) => r.customer_id !== input.customerId),
      beforeDeliveryCommands
    )
    assert.equal(deliveryPreferences.length, beforeDeliveryPreferences.length + 1)
    assert.deepEqual(
      deliveryPreferences.filter((r) => r.customer_id !== input.customerId),
      beforeDeliveryPreferences
    )
    assert.equal(privacy.length, beforePrivacy.length + 1)
    assert.deepEqual(
      privacy.filter((r) => r.customer_id !== input.customerId),
      beforePrivacy
    )
    const own = privacy.find((r) => r.customer_id === input.customerId)
    assert.equal(own?.id, privacyReceipt.id)
    assert.equal(own?.actor_id, input.identityId)
    assert.equal(own?.command_id, privacyReceipt.commandId)
    assert.equal(own?.request_type, 'export')
    assert.equal(own?.status, 'completed')
    return { ...counters }
  }
  return { forward, assertComplete, state: () => ({ ...counters }) }
}

export async function auditNativeAccountSettingsBrowser(input: NativeAccountSettingsBrowserInput) {
  isolatedOrigin(input.origin)
  assert(input.browserMode === undefined || ['required', 'not-run'].includes(input.browserMode))
  if (input.browserMode === 'not-run')
    return {
      scenarios: 0,
      browserExecuted: false,
      reason: REMOTE_BROWSER_NOT_RUN_REASON,
      viewports: [],
      preferencePuts: null,
      privacyPosts: null,
      downloads: null
    }
  const browser = await connectRemoteTestBrowser(chromium),
    contexts: BrowserContext[] = [],
    viewports: Array<'desktop' | 'mobile'> = ['desktop', 'mobile']
  let scenarios = 0
  try {
    for (const [index, viewport] of viewports.entries()) {
      const owner = await input.prepareOwner(viewport),
        bridge = await createAccountSettingsBrowserBridge({ ...input, ...owner }),
        context = await browser.newContext({
          locale: 'es-ES',
          timezoneId: 'Europe/Madrid',
          serviceWorkers: 'block',
          acceptDownloads: true,
          viewport: viewport === 'desktop' ? { width: 1440, height: 1000 } : { width: 390, height: 844 }
        })
      contexts.push(context)
      await context.addCookies([
        {
          name: 'neteco-session',
          value: cookieValue(owner.ownerCookie),
          url: input.origin,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax'
        }
      ])
      let transportFailure = false,
        pageErrors = 0
      await context.route('**/*', async (route) => {
        try {
          const incoming = route.request(),
            headers = await incoming.allHeaders(),
            payload = incoming.postDataBuffer()
          headers['cf-connecting-ip'] = '192.0.2.165'
          headers['accept-encoding'] = 'identity'
          const result = await bridge.forward(
            new Request(incoming.url(), {
              method: incoming.method(),
              headers,
              redirect: 'manual',
              ...(payload ? { body: Uint8Array.from(payload).buffer } : {})
            })
          )
          if (result.action === 'abort') {
            if (
              !['proven_preference_response_lost', 'proven_delivery_preference_response_lost'].includes(result.reason)
            )
              transportFailure = true
            await route.abort('failed')
          } else {
            const forwarded = Object.fromEntries(result.response.headers)
            delete forwarded['content-length']
            delete forwarded['content-encoding']
            await route.fulfill({
              status: result.response.status,
              headers: forwarded,
              body: Buffer.from(await result.response.arrayBuffer())
            })
          }
        } catch {
          transportFailure = true
          await route.abort('failed')
        }
      })
      const page = await context.newPage()
      page.on('pageerror', () => {
        pageErrors++
      })
      await page.goto(input.origin + '/cuenta/comunicaciones', { waitUntil: 'networkidle', timeout: 30000 })
      const product = page.locator('[data-preferences-product]'),
        replenishment = page.locator('[data-preferences-replenishment]'),
        privacy = page.getByRole('region', { name: 'Privacidad de cuenta', exact: true })
      await expect(product).toBeEnabled({ timeout: 15000 })
      await expect(product).not.toBeChecked()
      await expect(replenishment).not.toBeChecked()
      await expect(privacy).toBeVisible()
      await product.check()
      await replenishment.check()
      await page.locator('[data-preferences-ack]').check()
      await page.locator('[data-preferences-ack]').focus()
      await page.keyboard.press('Tab')
      await expect(page.locator('[data-preferences-submit]')).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-preferences-unknown]')).toBeVisible({ timeout: 15000 })
      await expect(privacy).toHaveCount(0)
      assert.equal(bridge.state().privacyPosts, 0)
      await page.locator('[data-preferences-check]').focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-preferences-confirmed]')).toBeVisible({ timeout: 15000 })
      assert.equal(bridge.state().preferencePuts, 1)
      const delivery = page.getByRole('region', { name: 'Avisos de entrega', exact: true })
      await expect(delivery).toBeVisible()
      const deliveryChoice = delivery.getByLabel('Recibir avisos de preparación y entrega', { exact: true })
      await expect(deliveryChoice).toBeChecked()
      await deliveryChoice.uncheck()
      await delivery.locator('[data-delivery-ack]').check()
      await delivery.getByRole('button', { name: 'Guardar avisos de entrega', exact: true }).click()
      await expect(delivery.getByRole('button', { name: 'Comprobar avisos de entrega', exact: true })).toBeVisible({
        timeout: 15000
      })
      await expect(privacy).toHaveCount(0)
      await delivery.getByRole('button', { name: 'Comprobar avisos de entrega', exact: true }).click()
      await expect(
        delivery.getByText('Avisos de entrega guardados y estado actual confirmado.', { exact: true })
      ).toBeVisible({ timeout: 15000 })
      assert.equal(bridge.state().deliveryPuts, 1)
      await expect(privacy).toBeVisible()
      await privacy.getByRole('button', { name: 'Actualizar solicitudes', exact: true }).click()
      await expect(privacy.getByText('No hay solicitudes registradas.', { exact: true })).toBeVisible({
        timeout: 15000
      })
      await privacy.getByLabel('Tipo de solicitud', { exact: true }).selectOption('export')
      await privacy.getByRole('checkbox').check()
      await privacy.getByRole('checkbox').focus()
      await page.keyboard.press('Tab')
      await expect(privacy.getByRole('button', { name: 'Registrar solicitud', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      const link = privacy.getByRole('link', { name: 'Descargar JSON de mis datos', exact: true })
      await expect(link).toBeVisible({ timeout: 15000 })
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), link.click()])
      assert.match(download.suggestedFilename(), /^neteco-datos-[a-f0-9-]{36}\.json$/)
      const stream = await download.createReadStream()
      assert(stream, 'Actual browser download stream required')
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk)
        size += bytes.byteLength
        assert(size <= 2 * 1024 * 1024)
        chunks.push(bytes)
      }
      const exported = accountPrivacyExportSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      assert.equal(exported.profile.email, owner.ownerEmail)
      assert.equal(exported.accountPreferences?.product_updates, true)
      assert.equal(exported.accountPreferences?.replenishment, true)
      assert.equal(exported.deliveryPreferences?.deliveryUpdates, false)
      await bridge.assertComplete()
      assert.equal(bridge.state().blockedWrites, 0)
      assert.equal(bridge.state().blockedExternal, 0)
      assert.equal(transportFailure, false)
      assert.equal(pageErrors, 0)
      assert.equal(await page.locator('html').evaluate((element) => element.scrollWidth > window.innerWidth + 1), false)
      input.scenario?.(ACCOUNT_SETTINGS_BROWSER_SCENARIOS[index]!)
      scenarios++
      await context.close()
      contexts.pop()
    }
    return {
      scenarios,
      browserExecuted: true,
      viewports,
      engine: 'remote_playwright_chromium',
      transport: 'playwright_same_origin_forwarding_to_real_workerd',
      preferencePuts: 2,
      deliveryPuts: 2,
      privacyPosts: 2,
      downloads: 2
    }
  } finally {
    for (const context of contexts) await context.close()
    await browser.close()
  }
}
