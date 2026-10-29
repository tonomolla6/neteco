import { z } from 'zod'
import {
  newsletterCampaignDocumentSchema,
  newsletterPreferenceSchema,
  newsletterPolicyDocumentSchema,
  newsletterDispatchReportSchema,
  type NewsletterPreference,
  type NewsletterPolicyDocument,
  type NewsletterCampaignDocument
} from '../../shared/newsletter-editorial'
import {
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import { madridDateTimeParts } from '../../server/utils/madrid-calendar'
import { createNewsletterUnsubscribeToken } from './newsletter'
import { issueNewsletterPreferenceToken } from './newsletter-preferences'
import { editorialResourceId } from './newsletter-editorial-commands'
import { editorialCampaignHead, editorialCampaignVersion, editorialPolicyHead } from './newsletter-campaigns'
import {
  NewsletterEditorialError,
  assertEditorialEnabled,
  editorialNow,
  editorialSource,
  editorialJson,
  assertBatch,
  type NewsletterEditorialDependencies
} from './newsletter-editorial-core'
import {
  editorialLinksSql,
  editorialSourcesCte,
  validateEditorialLinks,
  renderNewsletterCampaign,
  editorialPercent
} from './newsletter-campaign-render'
import { transportReady, transportRecipientAllowed, resolveEditorialSender } from './newsletter-campaign-transport'

const joined = `FROM newsletter_editorial_deliveries d JOIN newsletter_editorial_campaigns c ON c.id=d.campaign_id
 JOIN newsletter_editorial_versions v ON v.id=d.version_id AND v.campaign_id=c.id
 JOIN newsletter_subscriptions s ON s.id=d.subscription_id
 LEFT JOIN newsletter_editorial_preferences p ON p.subscription_id=s.id
 JOIN newsletter_editorial_policies policy ON policy.id=c.policy_id`
// Recovery and editorial email share the same recipient boundary. A live
// recovery claim blocks the editorial marker; completed/ambiguous attempts
// retain the immutable configured cooldown, measured from actual completion.
const recoveryRecipientAllowed = `NOT EXISTS(
 SELECT 1 FROM cart_recovery_deliveries recovery
 JOIN cart_recovery_associations association ON association.id=recovery.association_id
 WHERE association.recipient=s.email_normalized AND (
 recovery.status='sending' OR (recovery.status IN('sent','manual_review') AND
 strftime('%Y-%m-%dT%H:%M:%SZ',recovery.finished_at,
 '+'||(unixepoch(recovery.next_eligible_at)-unixepoch(recovery.created_at))||' seconds')>?1)))`
// Only an actual non-confirmation send in flight holds this shared slot.
// No additional cooldown for a completed watch is inferred here.
const watchRecipientAllowed = `NOT EXISTS(
 SELECT 1 FROM product_watch_deliveries delivery
 JOIN product_watch_requests watch ON watch.id=delivery.watch_id
 WHERE watch.recipient=s.email_normalized AND delivery.kind<>'confirmation' AND delivery.status='sending')`
export function editorialAudienceSql(campaign: string, preference: string) {
  return `json_extract(${preference},'$.locale')=json_extract(${campaign},'$.locale')
 AND json_extract(${preference},'$.frequency') IN(SELECT value FROM json_each(${campaign},'$.frequencies'))
 AND NOT EXISTS(SELECT 1 FROM json_each(${campaign},'$.topics') topic WHERE NOT EXISTS(SELECT 1 FROM newsletter_editorial_topics t WHERE t.code=topic.value AND t.active=1))
 AND NOT EXISTS(SELECT 1 FROM json_each(${preference},'$.topics') topic WHERE NOT EXISTS(SELECT 1 FROM newsletter_editorial_topics t WHERE t.code=topic.value AND t.active=1))
 AND (json_array_length(${campaign},'$.topics')=0 OR json_array_length(${preference},'$.topics')=0
 OR (json_extract(${campaign},'$.topicMatch')='any' AND EXISTS(SELECT 1 FROM json_each(${campaign},'$.topics') wanted JOIN json_each(${preference},'$.topics') chosen ON wanted.value=chosen.value))
 OR (json_extract(${campaign},'$.topicMatch')='all' AND NOT EXISTS(SELECT 1 FROM json_each(${campaign},'$.topics') wanted WHERE wanted.value NOT IN(SELECT value FROM json_each(${preference},'$.topics')))))`
}
function eligible(deps: NewsletterEditorialDependencies) {
  return `NOT EXISTS(SELECT 1 FROM json_each(json_array(
 c.status='approved',c.revision=d.approval_revision,c.approved_version_id=d.version_id,
 c.starts_at<=?1,c.ends_at>?1,EXISTS(SELECT 1 FROM newsletter_editorial_policy_head head WHERE head.id='global' AND head.policy_id=c.policy_id),
 s.status='confirmed',NOT EXISTS(SELECT 1 FROM newsletter_suppressions suppression WHERE suppression.email_hash=s.email_hash),
 ${recoveryRecipientAllowed},${watchRecipientAllowed},
 p.document IS NOT NULL,${editorialAudienceSql('v.document', 'p.document')},
 ${editorialLinksSql('v.document', deps.cmsPublication?.enabled === true)})) WHERE value IS NOT 1)`
}
function matches(doc: NewsletterCampaignDocument, pref: NewsletterPreference) {
  return (
    doc.locale === pref.locale &&
    doc.frequencies.includes(pref.frequency) &&
    (doc.topics.length === 0 ||
      pref.topics.length === 0 ||
      (doc.topicMatch === 'any'
        ? doc.topics.some((t) => pref.topics.includes(t))
        : doc.topics.every((t) => pref.topics.includes(t))))
  )
}
function insideQuiet(now: string, hours: NewsletterPreference['quietHours']) {
  if (hours === null) return false
  const part = madridDateTimeParts(new Date(now)),
    minute = part.hour * 60 + part.minute
  return hours.startMinute < hours.endMinute
    ? minute >= hours.startMinute && minute < hours.endMinute
    : minute >= hours.startMinute || minute < hours.endMinute
}
export function nextNewsletterAllowedAt(now: string, pref: NewsletterPreference, policy: NewsletterPolicyDocument) {
  if (!insideQuiet(now, pref.quietHours) && !insideQuiet(now, policy.quietHours)) return now
  for (let offset = 1; offset <= 1500; offset++) {
    const value = new Date(Math.floor(Date.parse(now) / 60000) * 60000 + offset * 60000)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
    if (!insideQuiet(value, pref.quietHours) && !insideQuiet(value, policy.quietHours)) return value
  }
  throw new NewsletterEditorialError('quiet_hours')
}
const after = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
export async function expandNewsletterCampaign(deps: NewsletterEditorialDependencies, campaignId: string, limit = 100) {
  assertEditorialEnabled(deps)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NewsletterEditorialError('invalid_input')
  const head = await editorialCampaignHead(deps, campaignId),
    now = editorialNow(deps)
  if (
    head.status !== 'approved' ||
    head.fanout_complete === 1 ||
    !head.approved_version_id ||
    !head.policy_id ||
    !head.starts_at ||
    !head.ends_at ||
    head.starts_at > now ||
    head.ends_at <= now
  )
    return 0
  if ((await editorialPolicyHead(deps))?.policy_id !== head.policy_id) return 0
  const doc = await editorialCampaignVersion(deps, campaignId, head.approved_version_id)
  const rows = await deps.database
    .prepare(
      `SELECT s.id,p.document FROM newsletter_subscriptions s JOIN newsletter_editorial_preferences p ON p.subscription_id=s.id
 WHERE s.status='confirmed' AND s.confirmed_at<=?2 AND p.document IS NOT NULL AND (?1 IS NULL OR s.id>?1)
 AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash)
 ORDER BY s.id LIMIT ?3`
    )
    .bind(head.cursor, Math.floor(Date.parse(head.approved_at!) / 1000), limit + 1)
    .all()
  if (rows.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
  const data = editorialSource(
      z.array(z.object({ id: uuid, document: z.string() }).strict()).max(limit + 1),
      rows.results
    ),
    slice = data.slice(0, limit)
  const statements: D1PreparedStatement[] = []
  const txNow = editorialNow(deps)
  statements.push(
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_guards SELECT ?1,0 WHERE NOT EXISTS(SELECT 1 FROM newsletter_editorial_campaigns c
 WHERE c.id=?2 AND c.status='approved' AND c.revision=?3 AND c.approved_version_id=?4 AND c.cursor IS ?5 AND c.fanout_complete=0 AND c.ends_at>?6
 AND EXISTS(SELECT 1 FROM newsletter_editorial_policy_head head WHERE head.id='global' AND head.policy_id=c.policy_id))`
      )
      .bind(crypto.randomUUID(), campaignId, head.revision, head.approved_version_id, head.cursor, txNow)
  )
  for (const row of slice) {
    const pref = editorialJson(newsletterPreferenceSchema, row.document)
    if (!matches(doc, pref)) continue
    const id = await editorialResourceId(campaignId, row.id, 'delivery')
    statements.push(
      deps.database
        .prepare(
          `INSERT INTO newsletter_editorial_deliveries(id,campaign_id,version_id,subscription_id,approval_revision,status,available_at,created_at)
 SELECT ?1,?2,?3,s.id,?5,'pending',?6,?6 FROM newsletter_subscriptions s JOIN newsletter_editorial_preferences p ON p.subscription_id=s.id
 WHERE s.id=?4 AND s.status='confirmed' AND p.document IS NOT NULL AND NOT EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash)
 AND ${editorialAudienceSql('?7', 'p.document')} ON CONFLICT(campaign_id,subscription_id) DO NOTHING RETURNING id`
        )
        .bind(id, campaignId, head.approved_version_id, row.id, head.revision, txNow, JSON.stringify(doc))
    )
  }
  statements.push(
    deps.database
      .prepare(
        'UPDATE newsletter_editorial_campaigns SET cursor=?,fanout_complete=? WHERE id=? AND revision=? AND cursor IS ?'
      )
      .bind(slice.at(-1)?.id ?? head.cursor, Number(data.length <= limit), campaignId, head.revision, head.cursor)
  )
  try {
    const results = await deps.database.batch(statements)
    assertBatch(results, statements.length)
    return results
      .slice(1, -1)
      .reduce(
        (total, r) => total + editorialSource(z.array(z.object({ id: uuid }).strict()).max(1), r.results).length,
        0
      )
  } catch (failure) {
    const live = await editorialCampaignHead(deps, campaignId)
    if (live.revision !== head.revision || live.cursor !== head.cursor || live.fanout_complete !== 0) return 0
    throw failure
  }
}
const workSchema = z
  .object({
    id: uuid,
    campaign_id: uuid,
    version_id: uuid,
    subscription_id: uuid,
    approval_revision: z.number().int().min(1),
    campaign_status: z.string(),
    revision: z.number().int(),
    approved_version_id: uuid.nullable(),
    policy_id: uuid,
    starts_at: instant,
    ends_at: instant,
    email_normalized: z.string().email(),
    subscription_status: z.string(),
    suppressed: z.union([z.literal(0), z.literal(1)]),
    preference_revision: z.number().int().nullable(),
    preference: z.string().nullable(),
    document: z.string(),
    policy: z.string(),
    last_attempt_at: instant.nullable(),
    next_eligible_at: instant.nullable()
  })
  .strict()
async function work(deps: NewsletterEditorialDependencies, id: string) {
  const row = await deps.database
    .prepare(
      `SELECT d.id,d.campaign_id,d.version_id,d.subscription_id,d.approval_revision,c.status AS campaign_status,c.revision,c.approved_version_id,c.policy_id,c.starts_at,c.ends_at,
 s.email_normalized,s.status AS subscription_status,EXISTS(SELECT 1 FROM newsletter_suppressions x WHERE x.email_hash=s.email_hash) AS suppressed,
 p.revision AS preference_revision,p.document AS preference,v.document,policy.document AS policy,cap.last_attempt_at,cap.next_eligible_at
 ${joined} LEFT JOIN newsletter_editorial_caps cap ON cap.subscription_id=s.id WHERE d.id=?`
    )
    .bind(id)
    .first()
  if (row === null) throw new NewsletterEditorialError('source_unavailable')
  return editorialSource(workSchema, row)
}
export async function dispatchNewsletterCampaigns(
  deps: NewsletterEditorialDependencies,
  options: { limit?: number; campaignId?: string } = {}
) {
  assertEditorialEnabled(deps)
  const limit = options.limit ?? 25
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NewsletterEditorialError('invalid_input')
  if (options.campaignId) uuid.parse(options.campaignId)
  const transport = deps.transport,
    ready = transportReady(transport, deps.publicOrigin)
  const report = {
    source: 'cloudflare' as const,
    externalDelivery: ready && transport?.mode === 'cloudflare-email',
    disabled: !ready,
    expanded: 0,
    acceptedLocal: 0,
    acceptedProvider: 0,
    skipped: 0,
    deferred: 0,
    manualReview: 0
  }
  const stale = await deps.database
    .prepare(
      `UPDATE newsletter_editorial_deliveries SET status='manual_review',lease_token=NULL,lease_until=NULL,finished_at=?1,last_error_code='sending_lease_expired'
 WHERE status='sending' AND lease_until<=?1 RETURNING id`
    )
    .bind(editorialNow(deps))
    .all()
  if (stale.success !== true) throw new NewsletterEditorialError('write_unconfirmed')
  report.manualReview += stale.results.length
  if (!ready || !transport) return newsletterDispatchReportSchema.parse(report)
  const sender = resolveEditorialSender(transport, deps.publicOrigin)
  const campaigns = await deps.database
    .prepare(
      `SELECT id FROM newsletter_editorial_campaigns WHERE status='approved' AND fanout_complete=0 AND (?1 IS NULL OR id=?1) ORDER BY id LIMIT ?2`
    )
    .bind(options.campaignId ?? null, limit)
    .all()
  if (campaigns.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
  for (const row of editorialSource(z.array(z.object({ id: uuid }).strict()).max(limit), campaigns.results))
    report.expanded += await expandNewsletterCampaign(deps, row.id, limit)
  await deps.database
    .prepare(
      "UPDATE newsletter_editorial_deliveries SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=?"
    )
    .bind(editorialNow(deps))
    .run()
  const candidates = await deps.database
    .prepare(
      `SELECT id FROM newsletter_editorial_deliveries WHERE status='pending' AND available_at<=?1 AND (?2 IS NULL OR campaign_id=?2) ORDER BY available_at,id LIMIT ?3`
    )
    .bind(editorialNow(deps), options.campaignId ?? null, limit)
    .all()
  if (candidates.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
  for (const candidate of editorialSource(z.array(z.object({ id: uuid }).strict()).max(limit), candidates.results)) {
    const token = crypto.randomUUID(),
      leaseNow = editorialNow(deps)
    const claim = await deps.database
      .prepare(
        "UPDATE newsletter_editorial_deliveries SET status='leased',lease_token=?2,lease_until=?3 WHERE id=?1 AND status='pending' AND available_at<=?4 RETURNING id"
      )
      .bind(candidate.id, token, after(leaseNow, 60), leaseNow)
      .first()
    if (!claim) continue
    const finish = async (code: string) => {
      const row = await deps.database
        .prepare(
          "UPDATE newsletter_editorial_deliveries SET status='skipped',lease_token=NULL,lease_until=NULL,finished_at=?3,last_error_code=?4 WHERE id=?1 AND status IN('leased','sending') AND lease_token=?2 RETURNING id"
        )
        .bind(candidate.id, token, editorialNow(deps), code)
        .first()
      if (row) report.skipped++
    }
    const defer = async (at: string, code: string) => {
      const row = await deps.database
        .prepare(
          "UPDATE newsletter_editorial_deliveries SET status='pending',lease_token=NULL,lease_until=NULL,available_at=?3,last_error_code=?4 WHERE id=?1 AND status='leased' AND lease_token=?2 RETURNING id"
        )
        .bind(candidate.id, token, at, code)
        .first()
      if (row) report.deferred++
    }
    let item: z.infer<typeof workSchema>,
      doc: NewsletterCampaignDocument,
      pref: NewsletterPreference,
      policy: NewsletterPolicyDocument
    try {
      item = await work(deps, candidate.id)
      doc = editorialJson(newsletterCampaignDocumentSchema, item.document)
      policy = editorialJson(newsletterPolicyDocumentSchema, item.policy)
      if (
        item.campaign_status !== 'approved' ||
        item.revision !== item.approval_revision ||
        item.approved_version_id !== item.version_id
      ) {
        await finish('campaign_cancelled')
        continue
      }
      if (item.ends_at <= editorialNow(deps)) {
        await finish('window_closed')
        continue
      }
      if ((await editorialPolicyHead(deps))?.policy_id !== item.policy_id) {
        await finish('policy_unavailable')
        continue
      }
      if (item.subscription_status !== 'confirmed' || item.suppressed === 1) {
        await finish('consent_unavailable')
        continue
      }
      if (item.preference === null) {
        await finish('preference_unavailable')
        continue
      }
      pref = editorialJson(newsletterPreferenceSchema, item.preference)
      if (!matches(doc, pref)) {
        await finish('segment_changed')
        continue
      }
      if (!transportRecipientAllowed(transport, item.email_normalized)) {
        await finish(transport.mode === 'local-fake' ? 'local_recipient_forbidden' : 'preprod_recipient_forbidden')
        continue
      }
      const at = nextNewsletterAllowedAt(editorialNow(deps), pref, policy),
        interval = policy.intervalHours[pref.frequency]
      let allowed = at
      if (item.next_eligible_at && item.next_eligible_at > allowed) allowed = item.next_eligible_at
      if (item.last_attempt_at) {
        const currentCap = after(item.last_attempt_at, interval * 3600)
        if (currentCap > allowed) allowed = currentCap
      }
      if (item.starts_at > allowed) allowed = item.starts_at
      if (allowed >= item.ends_at) {
        await finish('window_closed')
        continue
      }
      if (allowed > editorialNow(deps)) {
        await defer(allowed, at > editorialNow(deps) ? 'quiet_hours' : 'frequency_cap')
        continue
      }
      if (editorialPercent(doc) < policy.minEditorialPercent) {
        await finish('policy_unavailable')
        continue
      }
      await validateEditorialLinks(deps, doc)
      if (!deps.newsletterSecrets) throw new NewsletterEditorialError('configuration_unavailable')
      const unsub = await createNewsletterUnsubscribeToken(item.subscription_id, deps.newsletterSecrets),
        manage = await issueNewsletterPreferenceToken(deps, item.subscription_id),
        unsubscribeUrl = new URL('/newsletter/baja', deps.publicOrigin),
        preferenceUrl = new URL('/newsletter/preferencias', deps.publicOrigin)
      unsubscribeUrl.searchParams.set('token', unsub)
      preferenceUrl.searchParams.set('token', manage)
      const rendered = renderNewsletterCampaign(doc, {
        origin: deps.publicOrigin,
        preview: false,
        unsubscribeUrl: unsubscribeUrl.toString(),
        preferenceUrl: preferenceUrl.toString()
      })
      await validateEditorialLinks(deps, doc)
      const markerNow = editorialNow(deps),
        markerGuard = `EXISTS(SELECT 1 ${joined} WHERE d.id=?2 AND d.status='leased' AND d.lease_token=?3 AND d.lease_until>?1 AND p.revision=?4 AND ${eligible(deps)})`
      const sources = editorialSourcesCte('?1', deps.cmsPublication?.enabled === true),
        statements = [
          deps.database
            .prepare(
              `${sources} INSERT INTO newsletter_editorial_caps(subscription_id,last_delivery_id,last_attempt_at,next_eligible_at)
 SELECT d.subscription_id,d.id,?1,?5 FROM newsletter_editorial_deliveries d WHERE d.id=?2 AND ${markerGuard}
 ON CONFLICT(subscription_id) DO UPDATE SET last_delivery_id=excluded.last_delivery_id,last_attempt_at=excluded.last_attempt_at,next_eligible_at=excluded.next_eligible_at
 WHERE newsletter_editorial_caps.next_eligible_at<=?1 AND strftime('%Y-%m-%dT%H:%M:%SZ',newsletter_editorial_caps.last_attempt_at,?6)<=?1`
            )
            .bind(
              markerNow,
              candidate.id,
              token,
              item.preference_revision,
              after(markerNow, interval * 3600),
              `+${interval} hours`
            ),
          deps.database
            .prepare(
              `${sources} UPDATE newsletter_editorial_deliveries SET status='sending',sending_at=?1,lease_until=?5,last_error_code=NULL,provider=?6
 WHERE id=?2 AND lease_token=?3 AND status='leased' AND ${markerGuard}
 AND EXISTS(SELECT 1 FROM newsletter_editorial_caps cap WHERE cap.subscription_id=newsletter_editorial_deliveries.subscription_id AND cap.last_delivery_id=?2 AND cap.last_attempt_at=?1) RETURNING id`
            )
            .bind(markerNow, candidate.id, token, item.preference_revision, after(markerNow, 900), transport.mode)
        ]
      const result = await deps.database.batch(statements)
      assertBatch(result, 2)
      if (result[1]?.results.length !== 1) {
        const cap = await deps.database
          .prepare('SELECT next_eligible_at FROM newsletter_editorial_caps WHERE subscription_id=?')
          .bind(item.subscription_id)
          .first()
        const checked = cap === null ? null : editorialSource(z.object({ next_eligible_at: instant }).strict(), cap)
        await defer(checked?.next_eligible_at ?? after(editorialNow(deps), 60), 'frequency_cap')
        continue
      }
      const final = await deps.database
        .prepare(
          `${sources} SELECT d.id ${joined} WHERE d.id=?2 AND d.status='sending' AND d.lease_token=?3 AND d.lease_until>?1 AND p.revision=?4 AND ${eligible(deps)}`
        )
        .bind(editorialNow(deps), candidate.id, token, item.preference_revision)
        .first()
      if (!final || !transportReady(deps.transport, deps.publicOrigin)) {
        await finish('consent_unavailable')
        continue
      }
      const sendClock = editorialNow(deps)
      if (sendClock >= item.ends_at) {
        await finish('window_closed')
        continue
      }
      if (nextNewsletterAllowedAt(sendClock, pref, policy) > sendClock) {
        await finish('quiet_hours')
        continue
      }
      // No asynchronous work remains before invoking the configured sender.
      let errorCode = 'provider_outcome_unknown'
      try {
        const receipt = editorialSource(
          z.object({ messageId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/) }).strict(),
          await sender.send({
            deliveryId: candidate.id,
            to: item.email_normalized,
            from: transport.from!,
            ...rendered,
            headers: { 'List-Unsubscribe': `<${unsubscribeUrl.toString()}>` }
          })
        )
        errorCode = 'provider_ack_failed'
        const ack = await deps.database
          .prepare(
            "UPDATE newsletter_editorial_deliveries SET status='accepted',lease_token=NULL,lease_until=NULL,finished_at=?3,provider_message_id=?4 WHERE id=?1 AND status='sending' AND lease_token=?2 RETURNING id"
          )
          .bind(candidate.id, token, editorialNow(deps), receipt.messageId)
          .first()
        if (ack) {
          if (transport.mode === 'local-fake') report.acceptedLocal++
          else report.acceptedProvider++
          continue
        }
      } catch (failure) {
        if (failure instanceof NewsletterEditorialError && failure.code === 'read_unconfirmed')
          errorCode = 'provider_receipt_invalid'
      }
      try {
        await deps.database
          .prepare(
            "UPDATE newsletter_editorial_deliveries SET status='manual_review',lease_token=NULL,lease_until=NULL,finished_at=?3,last_error_code=?4 WHERE id=?1 AND status='sending' AND lease_token=?2"
          )
          .bind(candidate.id, token, editorialNow(deps), errorCode)
          .run()
      } catch {
        /* A later disabled-mode sweep quarantines the expired send marker. */
      }
      report.manualReview++
    } catch (failure) {
      const state = await deps.database
        .prepare('SELECT status FROM newsletter_editorial_deliveries WHERE id=?')
        .bind(candidate.id)
        .first<{ status: string }>()
      if (state?.status === 'sending') {
        try {
          await deps.database
            .prepare(
              "UPDATE newsletter_editorial_deliveries SET status='manual_review',lease_token=NULL,lease_until=NULL,finished_at=?3,last_error_code='provider_outcome_unknown' WHERE id=?1 AND status='sending' AND lease_token=?2"
            )
            .bind(candidate.id, token, editorialNow(deps))
            .run()
        } catch {
          /* sweep */
        }
        report.manualReview++
      } else if (
        failure instanceof NewsletterEditorialError &&
        ['source_unavailable', 'quiet_hours', 'topic_unavailable', 'consent_unavailable'].includes(failure.code)
      )
        await finish(failure.code)
      else await defer(after(editorialNow(deps), 60), 'preparation_failed')
    }
  }
  await deps.database
    .prepare(
      `UPDATE newsletter_editorial_campaigns SET status='completed' WHERE status='approved' AND fanout_complete=1 AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_deliveries WHERE campaign_id=newsletter_editorial_campaigns.id AND status IN('pending','leased','sending'))`
    )
    .run()
  return newsletterDispatchReportSchema.parse(report)
}
