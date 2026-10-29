import { z } from 'zod'
import {
  newsletterPreferenceInputSchema,
  newsletterPreferenceAccessInputSchema,
  newsletterPreferenceAccessSchema,
  newsletterPreferenceSchema,
  newsletterPreferenceSnapshotSchema,
  newsletterTopicSchema
} from '../../shared/newsletter-editorial'
import { catalogPolicyUuidSchema as uuid } from '../../shared/catalog-publication-policy'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  NewsletterEditorialError,
  assertEditorialEnabled,
  editorialNow,
  editorialEpoch,
  editorialSource,
  editorialJson,
  editorialHash,
  stableJson,
  activeTopics,
  type NewsletterEditorialDependencies
} from './newsletter-editorial-core'
import { editorialReplay, commitEditorialCommand } from './newsletter-editorial-commands'
import { transportReady } from './newsletter-campaign-transport'

export type NewsletterPreferenceAuthority =
  { type: 'account'; claims: VerifiedSessionClaims } | { type: 'bearer'; token: string }
const signature = async (deps: NewsletterEditorialDependencies, message: string) => {
  const secret = deps.newsletterSecrets?.hmacKey
  if (!(secret instanceof Uint8Array) || secret.length < 32 || secret.length > 128)
    throw new NewsletterEditorialError('configuration_unavailable')
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`neteco:newsletter:preferences:v1:${message}`))
    ),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
}
/** Privileged reconstruction for the actual confirmed recipient. The bearer is
 * purpose-bound, short lived, and absent from the queue, audit and public GET. */
export async function issueNewsletterPreferenceToken(
  deps: NewsletterEditorialDependencies,
  subscriptionId: string,
  confirmationRequestId?: string
) {
  assertEditorialEnabled(deps)
  uuid.parse(subscriptionId)
  const id = crypto.randomUUID(),
    created = editorialEpoch(deps),
    expires = created + 1800,
    unsigned = `np1.${id}.${expires}`,
    token = `${unsigned}.${await signature(deps, unsigned)}`,
    hash = await editorialHash(token)
  const row = await deps.database
    .prepare(
      `INSERT INTO newsletter_editorial_access(id,subscription_id,token_hash,created_at,expires_at)
 SELECT ?1,s.id,?3,?4,?5 FROM newsletter_subscriptions s WHERE s.id=?2 AND s.status='confirmed'
 AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash)
 AND (?6 IS NULL OR (s.request_id=?6 AND s.confirmation_expires_at>?4)) RETURNING id`
    )
    .bind(id, subscriptionId, hash, created, expires, confirmationRequestId ?? null)
    .first()
  if (!row) throw new NewsletterEditorialError('consent_unavailable')
  editorialSource(z.object({ id: z.literal(id) }).strict(), row)
  return token
}
/** An anonymous subscriber proves the existing, unexpired DOI confirmation
 * token. Preferences/access never confirm a subscription themselves. */
export async function exchangeNewsletterConfirmationForPreferences(
  deps: NewsletterEditorialDependencies,
  raw: unknown
) {
  assertEditorialEnabled(deps)
  const input = newsletterPreferenceAccessInputSchema.safeParse(raw),
    secret = deps.newsletterSecrets?.hmacKey
  if (!input.success) throw new NewsletterEditorialError('invalid_input')
  if (!(secret instanceof Uint8Array) || secret.length < 32 || secret.length > 128)
    throw new NewsletterEditorialError('configuration_unavailable')
  const match = /^n1\.([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(input.data.confirmationToken)!
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify'
  ])
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      key,
      Uint8Array.from(match[2]!.match(/../g)!, (v) => parseInt(v, 16)),
      new TextEncoder().encode(`neteco:newsletter:confirm:v1:${match[1]}`)
    ))
  )
    throw new NewsletterEditorialError('unauthenticated')
  const proof = await deps.database
    .prepare(
      `SELECT s.id FROM newsletter_subscriptions s WHERE s.request_id=? AND s.status='confirmed' AND s.confirmation_expires_at>?
 AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash)`
    )
    .bind(match[1], editorialEpoch(deps))
    .first()
  if (proof === null) throw new NewsletterEditorialError('unauthenticated')
  const sub = editorialSource(z.object({ id: uuid }).strict(), proof),
    token = await issueNewsletterPreferenceToken(deps, sub.id, match[1])
  return newsletterPreferenceAccessSchema.parse({ source: 'cloudflare', token, expiresInSeconds: 1800 })
}
const SUB = z.object({ id: uuid, status: z.enum(['pending', 'confirmed', 'unsubscribed', 'suppressed']) }).strict()
type Owner = {
  subscriptionId: string | null
  status: z.infer<typeof SUB>['status'] | 'not_subscribed'
  actor: string
  sql: string
  binds: readonly (string | number | null)[]
}
export async function resolveNewsletterPreferenceOwner(
  deps: NewsletterEditorialDependencies,
  authority: NewsletterPreferenceAuthority
): Promise<Owner> {
  const clock = editorialNow(deps)
  if (authority.type === 'account') {
    const c = authority.claims
    const row = await deps.database
      .prepare(
        `SELECT i.email FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?1 AND i.id=?2 AND s.session_version=?3 AND s.revoked_at IS NULL AND s.created_at<=?4 AND s.expires_at>?4
 AND i.status='active' AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=?4
 AND (s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL))`
      )
      .bind(c.sessionId, c.identityId, c.sessionVersion, clock)
      .first()
    if (row === null) throw new NewsletterEditorialError('unauthenticated')
    const email = editorialSource(z.object({ email: z.string().email() }).strict(), row).email
    const raw = await deps.database
      .prepare('SELECT id,status FROM newsletter_subscriptions WHERE email_normalized=?')
      .bind(email.toLowerCase())
      .first()
    const sub = raw === null ? null : editorialSource(SUB, raw)
    return {
      subscriptionId: sub?.id ?? null,
      status: sub?.status ?? 'not_subscribed',
      actor: sub?.id ?? c.identityId,
      sql: `EXISTS(SELECT 1 FROM auth_sessions sess JOIN identities ident ON ident.id=sess.identity_id AND ident.session_version=sess.session_version
 JOIN newsletter_subscriptions sub ON sub.email_normalized=lower(ident.email)
 WHERE sess.id=?2 AND ident.id=?3 AND sess.session_version=?4 AND sub.id=?5 AND sess.revoked_at IS NULL AND sess.created_at<=?1 AND sess.expires_at>?1
 AND ident.status='active' AND ident.email_verified_at IS NOT NULL AND ident.email_verified_at<=?1
 AND (sess.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=ident.id AND m.verified_at IS NOT NULL)))`,
      binds: [clock, c.sessionId, c.identityId, c.sessionVersion, sub?.id ?? null]
    }
  }
  const match = /^np1\.([0-9a-f-]{36})\.([1-9]\d{9})\.([a-f0-9]{64})$/.exec(authority.token)
  if (!match || !uuid.safeParse(match[1]).success) throw new NewsletterEditorialError('unauthenticated')
  const unsigned = `np1.${match[1]}.${match[2]}`,
    expected = await signature(deps, unsigned)
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(deps.newsletterSecrets!.hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const good = await crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(match[3]!.match(/../g)!, (v) => parseInt(v, 16)),
    new TextEncoder().encode(`neteco:newsletter:preferences:v1:${unsigned}`)
  )
  if (!good || expected !== match[3] || Number(match[2]) <= editorialEpoch(deps))
    throw new NewsletterEditorialError('unauthenticated')
  const digest = await editorialHash(authority.token),
    raw = await deps.database
      .prepare(
        `SELECT s.id,s.status FROM newsletter_editorial_access a JOIN newsletter_subscriptions s ON s.id=a.subscription_id
 WHERE a.id=? AND a.token_hash=? AND a.expires_at=? AND a.created_at<=? AND a.expires_at>?`
      )
      .bind(match[1], digest, Number(match[2]), editorialEpoch(deps), editorialEpoch(deps))
      .first()
  if (raw === null) throw new NewsletterEditorialError('unauthenticated')
  const sub = editorialSource(SUB, raw)
  return {
    subscriptionId: sub.id,
    status: sub.status,
    actor: sub.id,
    sql: `EXISTS(SELECT 1 FROM newsletter_editorial_access access WHERE access.id=?2 AND access.token_hash=?3 AND access.subscription_id=?5 AND access.created_at<=?4 AND access.expires_at>?4)`,
    binds: [clock, match[1]!, digest, editorialEpoch(deps), sub.id]
  }
}
export async function readNewsletterPreferences(
  deps: NewsletterEditorialDependencies,
  authority: NewsletterPreferenceAuthority
) {
  assertEditorialEnabled(deps)
  const owner = await resolveNewsletterPreferenceOwner(deps, authority)
  const raw = owner.subscriptionId
    ? await deps.database
        .prepare('SELECT revision,document FROM newsletter_editorial_preferences WHERE subscription_id=?')
        .bind(owner.subscriptionId)
        .first()
    : null
  const pref =
    raw === null
      ? null
      : editorialSource(z.object({ revision: z.number().int().min(1), document: z.string().nullable() }).strict(), raw)
  const topics = await deps.database
    .prepare('SELECT id,code,label,active,revision FROM newsletter_editorial_topics ORDER BY code')
    .all()
  if (topics.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
  const rows = editorialSource(
    z.array(
      z
        .object({
          id: uuid,
          code: z.string(),
          label: z.string(),
          active: z.union([z.literal(0), z.literal(1)]),
          revision: z.number().int().min(1)
        })
        .strict()
    ),
    topics.results
  )
  const live = await resolveNewsletterPreferenceOwner(deps, authority)
  if (live.subscriptionId !== owner.subscriptionId || live.status !== owner.status)
    throw new NewsletterEditorialError('read_unconfirmed')
  return newsletterPreferenceSnapshotSchema.parse({
    source: 'cloudflare',
    subscriptionId: owner.subscriptionId,
    status: live.status,
    revision: pref?.revision ?? 0,
    preference: pref?.document ? editorialJson(newsletterPreferenceSchema, pref.document) : null,
    topics: rows.map((t) => newsletterTopicSchema.parse({ ...t, active: t.active === 1 })),
    canSave: live.status === 'confirmed',
    canUnsubscribe: ['pending', 'confirmed', 'suppressed'].includes(live.status),
    externalDelivery: deps.transport?.mode === 'cloudflare-email' && transportReady(deps.transport, deps.publicOrigin)
  })
}
export async function saveNewsletterPreferences(
  deps: NewsletterEditorialDependencies,
  authority: NewsletterPreferenceAuthority,
  raw: unknown,
  key: string
) {
  assertEditorialEnabled(deps)
  const parsed = newsletterPreferenceInputSchema.safeParse(raw)
  if (!parsed.success) throw new NewsletterEditorialError('invalid_input')
  const input = parsed.data,
    owner = await resolveNewsletterPreferenceOwner(deps, authority)
  if (!owner.subscriptionId) throw new NewsletterEditorialError('not_found')
  const subscriptionId = owner.subscriptionId
  const authorize = async () => {
    const live = await resolveNewsletterPreferenceOwner(deps, authority)
    if (live.subscriptionId !== subscriptionId) throw new NewsletterEditorialError('unauthenticated')
  }
  const hash = await editorialHash(stableJson({ subscriptionId, input })),
    previous = await editorialReplay(deps, 'subscription', subscriptionId, key, hash, authorize)
  if (previous) return previous
  const rawHead = await deps.database
    .prepare('SELECT revision,document FROM newsletter_editorial_preferences WHERE subscription_id=?')
    .bind(subscriptionId)
    .first()
  const before =
    rawHead === null
      ? null
      : editorialSource(
          z.object({ revision: z.number().int().min(1), document: z.string().nullable() }).strict(),
          rawHead
        )
  if ((before?.revision ?? 0) !== input.expectedRevision) {
    const winner = await editorialReplay(deps, 'subscription', subscriptionId, key, hash, authorize)
    if (winner) return winner
    throw new NewsletterEditorialError('version_conflict')
  }
  if (input.action === 'save' && owner.status !== 'confirmed') throw new NewsletterEditorialError('consent_unavailable')
  if (input.action === 'unsubscribe' && owner.status === 'unsubscribed')
    throw new NewsletterEditorialError('consent_unavailable')
  if (input.action === 'save') await activeTopics(deps, input.preference.topics)
  const fresh = await resolveNewsletterPreferenceOwner(deps, authority),
    now = editorialNow(deps),
    document = input.action === 'save' ? stableJson(input.preference) : (before?.document ?? null)
  const statements = [
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_preferences(subscription_id,revision,document,updated_at) VALUES (?,1,?,?)
 ON CONFLICT(subscription_id) DO UPDATE SET revision=revision+1,document=excluded.document,updated_at=excluded.updated_at WHERE revision=?`
      )
      .bind(subscriptionId, document, now, input.expectedRevision)
  ]
  if (input.action === 'unsubscribe')
    statements.push(
      deps.database
        .prepare(
          `UPDATE newsletter_subscriptions SET status='unsubscribed',unsubscribed_at=? WHERE id=? AND status IN('pending','confirmed','suppressed')`
        )
        .bind(editorialEpoch(deps), subscriptionId)
    )
  const eligible =
    input.action === 'save'
      ? ` AND EXISTS(SELECT 1 FROM newsletter_subscriptions s WHERE s.id=?5 AND s.status='confirmed' AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash))`
      : ` AND EXISTS(SELECT 1 FROM newsletter_subscriptions s WHERE s.id=?5 AND s.status IN('pending','confirmed','suppressed'))`
  const preSql =
    fresh.sql +
    eligible +
    ' AND COALESCE((SELECT revision FROM newsletter_editorial_preferences WHERE subscription_id=?5),0)=?6'
  let postSql =
    fresh.sql + ' AND EXISTS(SELECT 1 FROM newsletter_editorial_preferences WHERE subscription_id=?5 AND revision=?6)'
  const postBinds: (string | number | null)[] = [...fresh.binds, input.expectedRevision + 1]
  if (input.action === 'save') {
    postSql += eligible
    postSql += ` AND (SELECT count(*) FROM newsletter_editorial_topics WHERE active=1 AND code IN(SELECT value FROM json_each(?7)))=?8`
    postBinds.push(stableJson(input.preference.topics), input.preference.topics.length)
  } else
    postSql +=
      " AND EXISTS(SELECT 1 FROM newsletter_subscriptions s JOIN newsletter_suppressions x ON x.email_hash=s.email_hash WHERE s.id=?5 AND s.status='unsubscribed')"
  return commitEditorialCommand(deps, {
    scope: 'subscription',
    actor: subscriptionId,
    key,
    hash,
    action: input.action,
    resourceId: subscriptionId,
    expectedRevision: input.expectedRevision,
    input,
    before,
    after: { revision: input.expectedRevision + 1, document },
    statements,
    preSql,
    preBinds: [...fresh.binds, input.expectedRevision],
    postSql,
    postBinds,
    authorize
  })
}
