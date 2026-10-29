import { readFile } from 'node:fs/promises'
import { cmsFixture, CMS_CLAIMS } from './d1-cms-fixture'
import { requestNewsletterConsent, confirmNewsletterConsent } from '../../workers/marketing/newsletter'
import {
  issueNewsletterPreferenceToken,
  saveNewsletterPreferences
} from '../../workers/marketing/newsletter-preferences'
import {
  executeNewsletterEditorialAdmin,
  readNewsletterEditorialAdmin
} from '../../workers/marketing/newsletter-campaigns'
import { newsletterCampaignDocumentSchema, newsletterPolicyDocumentSchema } from '../../shared/newsletter-editorial'
import type { NewsletterEditorialHttpDependencies } from '../../workers/marketing/newsletter-editorial-core'
import type { NewsletterEditorialMessage } from '../../workers/marketing/newsletter-campaign-transport'
import { NEWSLETTER_CONSENT_TEXT, NEWSLETTER_POLICY_VERSION } from '../../shared/newsletter'

export const newsletterCampaignDocument = () =>
  newsletterCampaignDocumentSchema.parse({
    name: 'Guía de limpieza sintética',
    subject: 'Guía editorial sin destinatarios reales',
    locale: 'es',
    topics: [],
    topicMatch: 'any',
    frequencies: ['immediate', 'weekly', 'monthly'],
    blocks: [
      { id: crypto.randomUUID(), type: 'paragraph', kind: 'editorial', text: 'Contenido educativo sintético y seguro.' }
    ],
    changeSummary: 'Versión sintética inicial'
  })
export const newsletterPolicyDocument = () =>
  newsletterPolicyDocumentSchema.parse({
    name: 'Política sintética explícita',
    reason: 'Autoridad de prueba, no aprobación de producción',
    intervalHours: { immediate: 24, weekly: 168, monthly: 744 },
    quietHours: null,
    minEditorialPercent: 70,
    locale: 'es'
  })
export async function newsletterEditorialFixture() {
  const world = await cmsFixture()
  // D1 serializes atomic batches; node:sqlite has one synchronous connection.
  // Keep every real SQL statement/constraint while avoiding nested BEGINs when
  // two dispatcher promises deliberately contend in the concurrency regression.
  const batch = world.database.batch.bind(world.database)
  let tail = Promise.resolve()
  world.database = {
    ...world.database,
    batch: (statements) => {
      const result = tail.then(() => batch(statements))
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
  if (!world.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='newsletter_editorial_campaigns'").get())
    world.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0050_newsletter_editorial.sql', import.meta.url), 'utf8')
    )
  if (!world.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='product_watch_requests'").get())
    world.sqlite.exec(await readFile(new URL('../../db/d1/migrations/0087_product_watch.sql', import.meta.url), 'utf8'))
  world.sqlite.exec(await readFile(new URL('../../db/d1/migrations/0090_cart_recovery.sql', import.meta.url), 'utf8'))
  let now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const secrets = { hmacKey: crypto.getRandomValues(new Uint8Array(32)) },
    sent: NewsletterEditorialMessage[] = []
  const deps: NewsletterEditorialHttpDependencies = {
    database: world.database,
    enabled: true,
    publicOrigin: 'https://newsletter.neteco.test',
    now: () => now,
    newsletterSecrets: secrets,
    session: {
      password: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join(''),
      maxAgeSeconds: 3600
    },
    edgeLimiter: { limit: async () => ({ success: true }) },
    rateLimitPepper: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    feedback: { provider: 'local-fake', secret: crypto.getRandomValues(new Uint8Array(32)) },
    transport: {
      mode: 'local-fake',
      environment: 'local',
      from: 'newsletter@example.invalid',
      senderFactory: () => ({
        kind: 'local-fake',
        send: async (message) => {
          sent.push(message)
          return { messageId: `synthetic-${message.deliveryId}` }
        }
      })
    }
  }
  async function subscriber(
    email = 'cms@example.invalid',
    topics: string[] = [],
    frequency: 'immediate' | 'weekly' | 'monthly' = 'immediate'
  ) {
    const at = Math.floor(Date.parse(now) / 1000),
      consent = await requestNewsletterConsent(
        world.database,
        {
          email,
          purpose: 'newsletter',
          consentText: NEWSLETTER_CONSENT_TEXT,
          consentVersion: NEWSLETTER_POLICY_VERSION,
          consentSource: 'footer',
          idempotencyKey: crypto.randomUUID(),
          now: at
        },
        secrets
      )
    if (!consent.internalDelivery) throw new Error('missing DOI fixture')
    await confirmNewsletterConsent(world.database, consent.internalDelivery.confirmationToken, secrets, at)
    const row = world.sqlite.prepare('SELECT id FROM newsletter_subscriptions WHERE email_normalized=?').get(email) as {
      id: string
    }
    const token = await issueNewsletterPreferenceToken(deps, row.id),
      authority = { type: 'bearer' as const, token }
    await saveNewsletterPreferences(
      deps,
      authority,
      { action: 'save', expectedRevision: 0, preference: { frequency, topics, locale: 'es', quietHours: null } },
      crypto.randomUUID()
    )
    return { id: row.id, token, authority }
  }
  async function policy() {
    const snapshot = await readNewsletterEditorialAdmin(deps, CMS_CLAIMS)
    return executeNewsletterEditorialAdmin(
      deps,
      CMS_CLAIMS,
      null,
      {
        action: 'set_policy',
        expectedRevision: snapshot.policyRevision,
        policy: newsletterPolicyDocument(),
        reason: 'Política de prueba explícita'
      },
      crypto.randomUUID()
    )
  }
  async function campaign(approve = true, document = newsletterCampaignDocument()) {
    const created = await executeNewsletterEditorialAdmin(
      deps,
      CMS_CLAIMS,
      null,
      {
        action: 'create_campaign',
        expectedRevision: 0,
        document,
        reason: 'Creación sintética'
      },
      crypto.randomUUID()
    )
    if (!approve) return created.resourceId
    const snapshot = await readNewsletterEditorialAdmin(deps, CMS_CLAIMS),
      item = snapshot.campaigns.find((c) => c.id === created.resourceId)!
    const parts = (instant: string) =>
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Madrid',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .format(new Date(instant))
        .replace(' ', 'T')
    await executeNewsletterEditorialAdmin(
      deps,
      CMS_CLAIMS,
      item.id,
      {
        action: 'approve_campaign',
        expectedRevision: item.revision,
        versionId: item.versionId,
        policyId: snapshot.policy!.id,
        startsAtLocal: parts(new Date(Date.parse(now) - 60000).toISOString()),
        endsAtLocal: parts(new Date(Date.parse(now) + 604800000).toISOString()),
        repeatedHour: 'earlier',
        reason: 'Aprobación sintética por operador autorizado'
      },
      crypto.randomUUID()
    )
    return item.id
  }
  return {
    ...world,
    deps,
    sent,
    secrets,
    claims: CMS_CLAIMS,
    subscriber,
    policy,
    campaign,
    setNow: (value: string) => {
      now = value
    },
    getNow: () => now
  }
}
