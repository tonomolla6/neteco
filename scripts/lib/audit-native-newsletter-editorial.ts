import { strict as assert } from 'node:assert'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'
import {
  newsletterAdminSnapshotSchema,
  newsletterPreferenceSnapshotSchema,
  newsletterPreferenceAccessSchema,
  newsletterCommandReceiptSchema,
  newsletterPreviewSchema,
  newsletterDispatchReportSchema
} from '../../shared/newsletter-editorial'
import {
  requestNewsletterConsent,
  confirmNewsletterConsent,
  type NewsletterSecrets
} from '../../workers/marketing/newsletter'
import { z } from 'zod'

export interface NativeNewsletterEditorialAuditInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  newsletterSecrets: NewsletterSecrets
  feedbackSecret?: Uint8Array
  scenario: (name: string) => void
}
/** Actual workerd HTTP and D1 ledger. Every address/key/policy is an explicit
 * synthetic fixture; this helper does not contact or provision any provider. */
export async function auditNativeNewsletterEditorial(
  input: NativeNewsletterEditorialAuditInput
): Promise<{ scenarios: number }> {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, newsletterSecrets, scenario } = input,
    url = new URL(origin)
  assert.equal(url.origin, origin)
  assert.equal(url.protocol, 'https:')
  assert.ok(/\.(test|invalid)$/.test(url.hostname))
  assert.ok(newsletterSecrets.hmacKey instanceof Uint8Array && newsletterSecrets.hmacKey.length >= 32)
  let scenarios = 0
  const prefix = `native-newsletter-${crypto.randomUUID()}`,
    email = `${prefix}@example.invalid`,
    reason = 'Aprobación sintética explícita para auditoría local, nunca producción'
  async function http(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return dispatch(
      new Request(origin + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: adminCookie,
          'CF-Connecting-IP': '192.0.2.50',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }),
          ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
  }
  async function command(path: string, body: unknown, method = 'POST', key = crypto.randomUUID()) {
    const response = await http(path, method, body, { 'Idempotency-Key': key })
    assert.ok(response.status === 200 || response.status === 201, `newsletter command status ${response.status}`)
    return newsletterCommandReceiptSchema.parse(await response.json())
  }
  async function snapshot() {
    const response = await http('/api/admin/newsletter')
    assert.equal(response.status, 200)
    const raw = await response.json()
    assert.ok(!JSON.stringify(raw).includes(email))
    return newsletterAdminSnapshotSchema.parse(raw)
  }
  scenario('native_newsletter_default_private_operator_permissions_and_strict_contracts')
  assert.equal((await http('/api/admin/newsletter', 'GET', undefined, { Cookie: '' })).status, 401)
  assert.equal((await http('/api/admin/newsletter', 'GET', undefined, { Cookie: unprivilegedCookie })).status, 403)
  const initial = await snapshot()
  assert.equal(initial.capabilities.externalDelivery, false)
  assert.equal(initial.capabilities.localDispatch, true)
  assert.equal(
    (
      await http('/api/admin/newsletter/topics', 'POST', {
        action: 'create_topic',
        expectedRevision: 0,
        code: 'invalid',
        label: 'Invalid',
        reason,
        consent: true
      })
    ).status,
    422
  )
  scenarios++
  scenario('native_newsletter_existing_double_opt_in_and_explicit_preferences_without_inferred_consent')
  const consent = await requestNewsletterConsent(
    database,
    {
      email,
      purpose: 'newsletter',
      consentText: NEWSLETTER_CONSENT_TEXT,
      consentVersion: NEWSLETTER_POLICY_VERSION,
      consentSource: 'footer',
      idempotencyKey: crypto.randomUUID()
    },
    newsletterSecrets
  )
  assert.ok(consent.internalDelivery)
  await confirmNewsletterConsent(database, consent.internalDelivery.confirmationToken, newsletterSecrets)
  const sub = z
    .object({ id: z.string().uuid(), status: z.literal('confirmed') })
    .strict()
    .parse(
      await database
        .prepare('SELECT id,status FROM newsletter_subscriptions WHERE email_normalized=?')
        .bind(email)
        .first()
    )
  const access = await http(
    '/api/newsletter/preferences/access',
    'POST',
    { confirmationToken: consent.internalDelivery.confirmationToken },
    { Cookie: '' }
  )
  assert.equal(access.status, 200)
  const token = newsletterPreferenceAccessSchema.parse(await access.json()).token,
    bearer = { Authorization: `Bearer ${token}` }
  const before = await http('/api/newsletter/preferences', 'GET', undefined, bearer)
  assert.equal(before.status, 200)
  assert.equal(newsletterPreferenceSnapshotSchema.parse(await before.json()).preference, null)
  const pref = {
      action: 'save',
      expectedRevision: 0,
      preference: { frequency: 'weekly', topics: [], locale: 'es', quietHours: null }
    },
    prefKey = crypto.randomUUID()
  const saved = await http('/api/newsletter/preferences', 'PUT', pref, { ...bearer, 'Idempotency-Key': prefKey })
  assert.equal(saved.status, 200)
  const receipt = newsletterCommandReceiptSchema.parse(await saved.json())
  assert.equal(receipt.resourceId, sub.id)
  const repeated = await http('/api/newsletter/preferences', 'PUT', pref, { ...bearer, 'Idempotency-Key': prefKey })
  assert.deepEqual(await repeated.json(), receipt)
  assert.equal((await http('/api/newsletter/preferences?token=' + token)).status, 400)
  scenarios++
  scenario('native_newsletter_explicit_policy_campaign_version_approval_and_actionless_device_preview')
  await command('/api/admin/newsletter/policy', {
    action: 'set_policy',
    expectedRevision: initial.policyRevision,
    reason,
    policy: {
      name: prefix,
      reason,
      intervalHours: { immediate: 24, weekly: 168, monthly: 744 },
      quietHours: null,
      minEditorialPercent: 100,
      locale: 'es'
    }
  })
  const doc = {
    name: prefix,
    subject: 'Contenido educativo sintético local',
    locale: 'es',
    topics: [],
    topicMatch: 'any',
    frequencies: ['weekly'],
    blocks: [
      {
        id: crypto.randomUUID(),
        type: 'paragraph',
        kind: 'editorial',
        text: 'Contenido de prueba sin compras por email ni perfiles inferidos.'
      }
    ],
    changeSummary: reason
  }
  const createKey = crypto.randomUUID(),
    createBody = { action: 'create_campaign', expectedRevision: 0, document: doc, reason },
    created = await command('/api/admin/newsletter/campaigns', createBody, 'POST', createKey)
  assert.deepEqual(await command('/api/admin/newsletter/campaigns', createBody, 'POST', createKey), created)
  assert.equal(
    (
      await http(
        '/api/admin/newsletter/campaigns',
        'POST',
        { ...createBody, reason: 'Cambio incompatible' },
        { 'Idempotency-Key': createKey }
      )
    ).status,
    409
  )
  const current = await snapshot(),
    campaign = current.campaigns.find((c) => c.id === created.resourceId)
  assert.ok(campaign)
  assert.ok(current.policy)
  const previewResponse = await http(`/api/admin/newsletter/campaigns/${campaign.id}/preview`)
  assert.equal(previewResponse.status, 200)
  const preview = newsletterPreviewSchema.parse(await previewResponse.json())
  assert.equal(preview.actionsEnabled, false)
  assert.equal(preview.synthetic, true)
  assert.ok(!preview.html.includes('href='))
  assert.ok(!preview.html.includes(token))
  const local = (date: Date) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .format(date)
      .replace(' ', 'T')
  await command(`/api/admin/newsletter/campaigns/${campaign.id}/approve`, {
    action: 'approve_campaign',
    expectedRevision: campaign.revision,
    versionId: campaign.versionId,
    policyId: current.policy.id,
    startsAtLocal: local(new Date(Date.now() - 60000)),
    endsAtLocal: local(new Date(Date.now() + 40 * 86400000)),
    repeatedHour: 'earlier',
    reason
  })
  assert.equal(
    (
      await http(`/api/admin/newsletter/campaigns/${campaign.id}`, 'PUT', {
        action: 'update_campaign',
        expectedRevision: 1,
        document: doc,
        reason
      })
    ).status,
    409
  )
  scenarios++
  scenario('native_newsletter_local_fake_queue_receipt_dedup_no_tokens_or_recipients_in_audit')
  const dispatched = await http(`/api/admin/newsletter/campaigns/${campaign.id}/dispatch`, 'POST', {})
  assert.equal(dispatched.status, 200)
  const report = newsletterDispatchReportSchema.parse(await dispatched.json())
  assert.equal(report.disabled, false)
  assert.equal(report.externalDelivery, false)
  assert.equal(report.acceptedProvider, 0)
  assert.ok(report.acceptedLocal >= 1)
  const delivery = z
    .object({
      id: z.string().uuid(),
      provider: z.literal('local-fake'),
      provider_message_id: z.string(),
      status: z.literal('accepted'),
      sending_at: z.string()
    })
    .strict()
    .parse(
      await database
        .prepare(
          'SELECT id,provider,provider_message_id,status,sending_at FROM newsletter_editorial_deliveries WHERE campaign_id=? AND subscription_id=?'
        )
        .bind(campaign.id, sub.id)
        .first()
    )
  const rerun = await http(`/api/admin/newsletter/campaigns/${campaign.id}/dispatch`, 'POST', {})
  assert.equal(rerun.status, 200)
  assert.equal(newsletterDispatchReportSchema.parse(await rerun.json()).acceptedLocal, 0)
  const audit = await database
    .prepare('SELECT input,response FROM newsletter_editorial_audit WHERE resource_id IN(?,?)')
    .bind(campaign.id, sub.id)
    .all()
  assert.equal(audit.success, true)
  assert.ok(!JSON.stringify(audit.results).includes(email))
  assert.ok(!JSON.stringify(audit.results).includes(token))
  scenarios++
  const receiveFeedback = async () => {
    if (!input.feedbackSecret) return
    scenario('native_newsletter_signed_known_receipt_feedback_dedup_and_irreversible_suppression')
    const body = {
        eventId: crypto.randomUUID(),
        messageId: delivery.provider_message_id,
        type: 'complaint',
        occurredAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      },
      raw = JSON.stringify(body),
      key = await crypto.subtle.importKey(
        'raw',
        new Uint8Array(input.feedbackSecret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      ),
      sig = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('')
    assert.equal(
      (await http('/api/webhooks/newsletter', 'POST', body, { 'x-neteco-email-signature': 'sha256=' + sig })).status,
      200
    )
    assert.equal(
      (await http('/api/webhooks/newsletter', 'POST', body, { 'x-neteco-email-signature': 'sha256=' + sig })).status,
      200
    )
    assert.equal((await http('/api/webhooks/newsletter', 'POST', body)).status, 401)
    const feedback = await database
      .prepare('SELECT event_type FROM newsletter_editorial_feedback WHERE provider=? AND event_id=?')
      .bind('local-fake', body.eventId)
      .all()
    assert.equal(feedback.success, true)
    assert.equal(feedback.results.length, 1)
    scenarios++
  }
  scenario('native_newsletter_shared_frequency_cap_across_distinct_approved_campaigns')
  // A second explicitly approved campaign must not evade the common recipient cap.
  const second = await command('/api/admin/newsletter/campaigns', createBody),
    state = await snapshot(),
    copy = state.campaigns.find((c) => c.id === second.resourceId)
  assert.ok(copy)
  assert.ok(state.policy)
  await command(`/api/admin/newsletter/campaigns/${copy.id}/approve`, {
    action: 'approve_campaign',
    expectedRevision: copy.revision,
    versionId: copy.versionId,
    policyId: state.policy.id,
    startsAtLocal: local(new Date(Date.now() - 60000)),
    endsAtLocal: local(new Date(Date.now() + 40 * 86400000)),
    repeatedHour: 'earlier',
    reason
  })
  const capDispatch = await http(`/api/admin/newsletter/campaigns/${copy.id}/dispatch`, 'POST', {})
  assert.equal(capDispatch.status, 200)
  assert.equal(newsletterDispatchReportSchema.parse(await capDispatch.json()).acceptedLocal, 0)
  const capped = z
    .object({ status: z.literal('pending'), last_error_code: z.literal('frequency_cap') })
    .strict()
    .parse(
      await database
        .prepare(
          'SELECT status,last_error_code FROM newsletter_editorial_deliveries WHERE campaign_id=? AND subscription_id=?'
        )
        .bind(copy.id, sub.id)
        .first()
    )
  assert.equal(capped.status, 'pending')
  scenarios++
  await receiveFeedback()
  scenario('native_newsletter_simple_unsubscribe_preserves_irreversible_suppression')
  const unsubscribe = await http(
    '/api/newsletter/preferences',
    'PUT',
    { action: 'unsubscribe', expectedRevision: 1 },
    bearer
  )
  assert.equal(unsubscribe.status, 200)
  const after = await http('/api/newsletter/preferences', 'GET', undefined, bearer)
  assert.equal(after.status, 200)
  assert.equal(newsletterPreferenceSnapshotSchema.parse(await after.json()).canSave, false)
  assert.equal((await http('/api/newsletter/preferences', 'PUT', { ...pref, expectedRevision: 2 }, bearer)).status, 409)
  const suppression = await database
    .prepare(
      'SELECT x.reason FROM newsletter_suppressions x JOIN newsletter_subscriptions s ON s.email_hash=x.email_hash WHERE s.id=?'
    )
    .bind(sub.id)
    .first()
  assert.ok(suppression)
  scenarios++
  scenario('native_newsletter_cancel_approval_exact_replay_and_no_pending_delivery_after_withdrawal')
  const latest = (await snapshot()).campaigns.find((c) => c.id === copy.id)
  assert.ok(latest)
  if (latest.status === 'approved') {
    const cancelKey = crypto.randomUUID(),
      cancelBody = { action: 'cancel_campaign', expectedRevision: latest.revision, reason },
      cancelled = await command(`/api/admin/newsletter/campaigns/${copy.id}/cancel`, cancelBody, 'POST', cancelKey)
    assert.deepEqual(
      await command(`/api/admin/newsletter/campaigns/${copy.id}/cancel`, cancelBody, 'POST', cancelKey),
      cancelled
    )
  }
  const outstanding = z
    .object({ n: z.number().int().min(0) })
    .strict()
    .parse(
      await database
        .prepare(
          "SELECT count(*) AS n FROM newsletter_editorial_deliveries WHERE campaign_id=? AND status IN('pending','leased','sending')"
        )
        .bind(copy.id)
        .first()
    )
  assert.equal(outstanding.n, 0)
  scenarios++
  return { scenarios }
}
