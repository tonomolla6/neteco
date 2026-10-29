import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cmsCommandReceiptSchema } from '../../shared/cms-commands'
import { cmsEditorialCalendarSchema } from '../../shared/cms-calendar'
import {
  cmsPublicationStateSchema,
  cmsPublicationReceiptSchema,
  cmsPublicPageSchema
} from '../../shared/cms-publication'
export interface NativeCmsPublicationAuditInput {
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  unprivilegedCookie: string
  scenario: (name: string) => void
  /** Optional existing genuine-byte, rights/scan-approved LOCAL fixture asset.
   * No product association is treated as CMS authorization. */
  imageUploadId?: string
}
/** Actual isolated workerd HTTP and D1 readbacks only. No fake DB, grants,
 * scanners, rights decisions, token issuers, provider requests or cron claims. */
export async function auditNativeCmsPublication(input: NativeCmsPublicationAuditInput): Promise<{ scenarios: number }> {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, scenario } = input
  assert.equal(new URL(origin).origin, origin)
  assert.equal(new URL(origin).protocol, 'https:')
  assert(origin === 'https://shop-audit.neteco.test' || new URL(origin).hostname.endsWith('.invalid'))
  const nonce = randomUUID(),
    slug = `cms-public-${nonce}`,
    changedSlug = `${slug}-draft`,
    title = `Native CMS release ${nonce}`,
    marker = `CMS PUBLIC SNAPSHOT ${nonce}`,
    root = '/api/admin/content/pages'
  const document = {
    title,
    slug,
    blocks: [
      { id: randomUUID(), type: 'paragraph', text: marker },
      ...(input.imageUploadId
        ? [
            {
              id: randomUUID(),
              type: 'image',
              assetId: input.imageUploadId,
              alt: 'Existing synthetic fixture image used by independent CMS approval',
              caption: 'Local runtime proof, not commercial rights acceptance'
            }
          ]
        : [])
    ],
    seo: {
      title: 'Synthetic CMS published page',
      description: 'Local workerd publication evidence only.',
      noindex: true
    },
    changeSummary: 'Explicit synthetic editorial creation'
  }
  let scenarios = 0,
    revision: number
  const request = (path: string, method = 'GET', body?: unknown, cookie = adminCookie, key = randomUUID()) => {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    assert(path.startsWith('/'))
    return dispatch(
      new Request(target, {
        method,
        headers: {
          origin,
          'cf-connecting-ip': '192.0.2.145',
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      })
    )
  }
  const effects = () =>
    database
      .prepare(
        `SELECT (SELECT count(*) FROM content_publications) AS releases,(SELECT count(*) FROM content_previews) AS previews,
  (SELECT count(*) FROM content_schedules) AS schedules,(SELECT count(*) FROM content_publication_commands) AS commands,(SELECT count(*) FROM content_publication_audit) AS audits,
  (SELECT count(*) FROM content_media_links) AS links,(SELECT count(*) FROM content_publication_guards) AS guards`
      )
      .first()
  async function denied(response: Response, status: number, code: string) {
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: { code } })
  }
  scenario('native_cms_publication_create_private_draft_and_real_unprivileged_denial')
  const createdResponse = await request(root, 'POST', { ...document, expectedVersion: 0 })
  assert.equal(createdResponse.status, 201)
  const created = cmsCommandReceiptSchema.parse(await createdResponse.json()),
    path = `${root}/${created.pageId}`
  let versionId = created.versionId
  const state = async () => {
    const response = await request(`${path}/publication`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const dto = cmsPublicationStateSchema.parse(await response.json())
    assert.equal(dto.pageId, created.pageId)
    return dto
  }
  const initial = await state()
  assert.equal(initial.revision, 0)
  assert.equal(initial.publication, null)
  assert.equal(initial.capabilities.publish, true)
  const publishInput = {
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: 1,
    versionId,
    reason: 'Explicit isolated synthetic editorial publication'
  }
  const beforeDenied = await effects()
  await denied(await request(`${path}/publish`, 'POST', publishInput, unprivilegedCookie), 403, 'forbidden')
  assert.deepEqual(await effects(), beforeDenied)
  assert.equal((await request(`/api/content/${slug}`, 'GET', undefined, '')).status, 404)
  scenarios++
  scenario('native_cms_publish_read_public_dto_ssr_and_optional_real_cms_derivative')
  const publishKey = randomUUID(),
    publishedResponse = await request(`${path}/publish`, 'POST', publishInput, adminCookie, publishKey)
  assert.equal(publishedResponse.status, 200)
  const publishedText = await publishedResponse.text(),
    published = cmsPublicationReceiptSchema.parse(JSON.parse(publishedText))
  revision = published.revision
  assert.equal(revision, 1)
  const publicResponse = await request(`/api/content/${slug}`, 'GET', undefined, '')
  assert.equal(publicResponse.status, 200)
  assert.equal(publicResponse.headers.get('cache-control'), 'private, no-store')
  assert.equal(publicResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  const publicPage = cmsPublicPageSchema.parse(await publicResponse.json())
  assert.equal(publicPage.title, title)
  assert.equal(publicPage.preview, false)
  assert.equal(publicPage.blocks[0]?.type, 'paragraph')
  const html = await request(`/contenido/${slug}`, 'GET', undefined, '')
  assert.equal(html.status, 200)
  const rendered = await html.text()
  assert(rendered.includes(title))
  assert(rendered.includes(marker))
  assert(rendered.includes('noindex'))
  const excludedSitemap = await request('/sitemaps/content.xml', 'GET', undefined, '')
  assert.equal(excludedSitemap.status, 200)
  assert.equal(excludedSitemap.headers.get('cache-control'), 'private, no-store')
  assert(!(await excludedSitemap.text()).includes(`/contenido/${slug}`))
  if (input.imageUploadId) {
    const mediaUrl = Object.values(publicPage.media)[0]
    assert(mediaUrl)
    const media = await request(mediaUrl, 'GET', undefined, '')
    assert.equal(media.status, 200)
    assert.equal(media.headers.get('content-type'), 'image/webp')
    assert((await media.arrayBuffer()).byteLength > 0)
    assert.equal((await request(`/media/${input.imageUploadId}`, 'GET', undefined, '')).status, 404)
  }
  const receiptRow = await database
    .prepare(
      'SELECT count(*) AS n FROM content_publication_commands c JOIN content_publication_audit a ON a.command_id=c.id AND a.response=c.response AND a.actor_id=c.actor_id WHERE c.page_id=?'
    )
    .bind(created.pageId)
    .first<{ n: number }>()
  assert.equal(receiptRow?.n, 1)
  scenarios++
  scenario('native_cms_publication_replay_exact_key_conflict_and_stale_cas_without_effects')
  const beforeReplay = await effects()
  const replay = await request(`${path}/publish`, 'POST', publishInput, adminCookie, publishKey)
  assert.equal(replay.status, 200)
  assert.equal(await replay.text(), publishedText)
  await denied(
    await request(
      `${path}/publish`,
      'POST',
      { ...publishInput, reason: 'Changed editorial approval' },
      adminCookie,
      publishKey
    ),
    409,
    'idempotency_conflict'
  )
  await denied(await request(`${path}/publish`, 'POST', publishInput), 409, 'version_conflict')
  assert.deepEqual(await effects(), beforeReplay)
  scenarios++
  scenario('native_cms_draft_edit_never_changes_public_title_slug_blocks_or_canonical')
  const changed = {
    ...document,
    title: `PRIVATE NEXT TITLE ${nonce}`,
    slug: changedSlug,
    blocks: [{ id: randomUUID(), type: 'paragraph', text: `PRIVATE NEXT MARKER ${nonce}` }],
    changeSummary: 'Draft-only next revision',
    expectedVersion: 1
  }
  const update = await request(path, 'PUT', changed)
  assert.equal(update.status, 200)
  const updated = cmsCommandReceiptSchema.parse(await update.json())
  const pageVersion = updated.pageVersion
  versionId = updated.versionId
  const stillPublic = cmsPublicPageSchema.parse(
    await (await request(`/api/content/${slug}`, 'GET', undefined, '')).json()
  )
  assert.equal(stillPublic.title, title)
  assert.equal(stillPublic.slug, slug)
  assert.deepEqual(stillPublic.blocks, publicPage.blocks)
  assert.equal((await request(`/api/content/${changedSlug}`, 'GET', undefined, '')).status, 404)
  const htmlAfter = await (await request(`/contenido/${slug}`, 'GET', undefined, '')).text()
  assert(!htmlAfter.includes(changed.title))
  assert(!htmlAfter.includes(`PRIVATE NEXT MARKER ${nonce}`))
  scenarios++
  scenario('native_cms_sealed_preview_exact_snapshot_or_explicit_disabled_configuration')
  const editorial = await state(),
    previewInput = {
      action: 'preview',
      expectedRevision: revision,
      expectedVersion: pageVersion,
      versionId,
      device: 'mobile',
      segment: 'default',
      reason: 'Explicit isolated private preview'
    }
  if (editorial.capabilities.preview) {
    const preview = await request(`${path}/preview`, 'POST', previewInput)
    assert.equal(preview.status, 200)
    const receipt = cmsPublicationReceiptSchema.parse(await preview.json())
    revision = receipt.revision
    assert(receipt.url && receipt.previewId)
    const previewToken = new URL(receipt.url, origin).searchParams.get('preview')
    assert(previewToken)
    const response = await request(
      `/api/content/${changedSlug}?preview=${encodeURIComponent(previewToken)}`,
      'GET',
      undefined,
      ''
    )
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    const privatePage = cmsPublicPageSchema.parse(await response.json())
    assert.equal(privatePage.title, changed.title)
    assert.equal(privatePage.previewDevice, 'mobile')
    const previewHtml = await request(receipt.url, 'GET', undefined, '')
    assert.equal(previewHtml.status, 200)
    assert((await previewHtml.text()).includes('375px'))
    const revoke = await request(`${path}/revoke-preview`, 'POST', {
      action: 'revoke_preview',
      previewId: receipt.previewId,
      expectedRevision: revision,
      expectedVersion: pageVersion,
      reason: 'Revoke this issued private bearer'
    })
    assert.equal(revoke.status, 200)
    revision = cmsPublicationReceiptSchema.parse(await revoke.json()).revision
    assert.equal(
      (await request(`/api/content/${changedSlug}?preview=${encodeURIComponent(previewToken)}`, 'GET', undefined, ''))
        .status,
      404
    )
  } else {
    const before = await effects()
    await denied(await request(`${path}/preview`, 'POST', previewInput), 501, 'preview_unavailable')
    assert.deepEqual(await effects(), before)
  }
  scenarios++
  scenario('native_cms_schedule_create_cancel_durable_exact_version_not_execution_claim')
  const publishAtLocal = '2090-01-01T10:00',
    schedule = await request(`${path}/schedule`, 'POST', {
      action: 'schedule',
      expectedRevision: revision,
      expectedVersion: pageVersion,
      versionId,
      publishAtLocal,
      unpublishAtLocal: '2090-01-01T11:00',
      repeatedHour: 'later',
      reason: 'Explicit synthetic future approval, not executed'
    })
  assert.equal(schedule.status, 200)
  const scheduled = cmsPublicationReceiptSchema.parse(await schedule.json())
  revision = scheduled.revision
  assert(scheduled.scheduleId)
  const queued = await state()
  assert.equal(queued.schedule?.versionId, versionId)
  assert.equal(queued.schedule?.publishAt, '2090-01-01T09:00:00Z')
  assert.equal(queued.schedule?.publishOutcome, null)
  scenario('native_cms_calendar_actual_http_private_live_grants_exact_madrid_approved_phases_no_writes')
  const beforeCalendar = await effects(),
    calendarPath = '/api/admin/content/calendar?month=2090-01&perPage=100'
  await denied(await request(calendarPath, 'GET', undefined, ''), 401, 'unauthenticated')
  await denied(await request(calendarPath, 'GET', undefined, unprivilegedCookie), 403, 'forbidden')
  const calendarResponse = await request(calendarPath)
  assert.equal(calendarResponse.status, 200)
  assert.equal(calendarResponse.headers.get('cache-control'), 'private, no-store')
  assert.equal(calendarResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  const calendar = cmsEditorialCalendarSchema.parse(await calendarResponse.json()),
    approvedPhases = calendar.events.filter((event) => event.scheduleId === scheduled.scheduleId)
  assert.equal(calendar.timeZone, 'Europe/Madrid')
  assert.equal(calendar.rangeStart, '2089-12-31T23:00:00Z')
  assert.equal(approvedPhases.length, 2)
  assert.deepEqual(
    approvedPhases.map((event) => [event.phase, event.status, event.localDateTime]),
    [
      ['publish', 'scheduled', '2090-01-01T10:00:00'],
      ['unpublish', 'scheduled', '2090-01-01T11:00:00']
    ]
  )
  assert(
    approvedPhases.every(
      (event) =>
        event.pageId === created.pageId &&
        event.versionId === versionId &&
        event.title === changed.title &&
        event.slug === changedSlug &&
        event.utcOffsetMinutes === 60 &&
        event.active
    )
  )
  assert.deepEqual(await effects(), beforeCalendar)
  scenarios++
  const cancel = await request(`${path}/cancel-schedule`, 'POST', {
    action: 'cancel_schedule',
    expectedRevision: revision,
    expectedVersion: pageVersion,
    reason: 'Cancel future approval without executing it'
  })
  assert.equal(cancel.status, 200)
  revision = cmsPublicationReceiptSchema.parse(await cancel.json()).revision
  assert.equal((await state()).schedule, null)
  assert.equal((await state()).publication?.id, published.publicationId)
  scenarios++
  scenario('native_cms_calendar_cancelled_immutable_history_not_pending_and_no_execution_claim')
  const beforeCancelledRead = await effects(),
    cancelledResponse = await request(calendarPath)
  assert.equal(cancelledResponse.status, 200)
  const cancelledCalendar = cmsEditorialCalendarSchema.parse(await cancelledResponse.json()),
    cancelledPhases = cancelledCalendar.events.filter((event) => event.scheduleId === scheduled.scheduleId)
  assert.equal(cancelledPhases.length, 2)
  assert(
    cancelledPhases.every(
      (event) => event.status === 'cancelled' && !event.active && event.recordedAt !== null && event.code === null
    )
  )
  assert(!cancelledCalendar.alerts.blockedEvents.some((event) => event.scheduleId === scheduled.scheduleId))
  assert.deepEqual(await effects(), beforeCancelledRead)
  scenarios++
  scenario('native_cms_explicit_withdraw_closes_public_ssr_api_and_previous_media_urls')
  const withdrawn = await request(`${path}/withdraw`, 'POST', {
    action: 'withdraw',
    expectedRevision: revision,
    expectedVersion: pageVersion,
    reason: 'Explicit isolated public release withdrawal'
  })
  assert.equal(withdrawn.status, 200)
  const receipt = cmsPublicationReceiptSchema.parse(await withdrawn.json())
  assert.equal(receipt.publicationId, null)
  for (const route of [
    `/api/content/${slug}`,
    `/contenido/${slug}`,
    `/api/content/${changedSlug}`,
    `/contenido/${changedSlug}`
  ]) {
    const response = await request(route, 'GET', undefined, '')
    assert.equal(response.status, 404)
    const text = await response.text()
    assert(!text.includes(title))
    assert(!text.includes(marker))
    assert(!text.includes(changed.title))
  }
  for (const url of Object.values(publicPage.media))
    assert.equal((await request(url, 'GET', undefined, '')).status, 404)
  assert.equal((await state()).publication, null)
  assert.equal(
    (await database.prepare('SELECT count(*) AS n FROM content_publication_guards').first<{ n: number }>())?.n,
    0
  )
  scenarios++
  scenario('native_cms_indexable_release_discovered_by_public_sitemap_then_withdrawn')
  const indexedSlug = `cms-sitemap-${nonce}`,
    indexedDocument = {
      ...document,
      slug: indexedSlug,
      seo: { ...document.seo, noindex: false },
      changeSummary: 'Explicit synthetic indexable editorial creation'
    },
    indexedCreate = await request(root, 'POST', { ...indexedDocument, expectedVersion: 0 })
  assert.equal(indexedCreate.status, 201)
  const indexedDraft = cmsCommandReceiptSchema.parse(await indexedCreate.json()),
    indexedPath = `${root}/${indexedDraft.pageId}`,
    indexedLocation = `${origin}/contenido/${indexedSlug}`
  const sitemapBefore = await request('/sitemaps/content.xml', 'GET', undefined, '')
  assert.equal(sitemapBefore.status, 200)
  assert(!(await sitemapBefore.text()).includes(indexedLocation))
  const indexedPublish = await request(`${indexedPath}/publish`, 'POST', {
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: indexedDraft.pageVersion,
    versionId: indexedDraft.versionId,
    reason: 'Explicit isolated indexable editorial approval'
  })
  assert.equal(indexedPublish.status, 200)
  const indexedRelease = cmsPublicationReceiptSchema.parse(await indexedPublish.json()),
    publicSitemap = await request('/sitemaps/content.xml', 'GET', undefined, ''),
    sitemapIndex = await request('/sitemap.xml', 'GET', undefined, '')
  assert.equal(publicSitemap.status, 200)
  assert.equal(publicSitemap.headers.get('cache-control'), 'private, no-store')
  const publicXml = await publicSitemap.text()
  assert(publicXml.includes(`<loc>${indexedLocation}</loc>`))
  assert(!publicXml.includes(`/contenido/${slug}`))
  assert(!publicXml.includes(`/contenido/${changedSlug}`))
  assert(!publicXml.includes('preview='))
  for (const privateValue of [indexedDraft.pageId, indexedDraft.versionId, indexedRelease.publicationId]) {
    assert(privateValue)
    assert(!publicXml.includes(privateValue))
  }
  assert.equal(sitemapIndex.status, 200)
  assert((await sitemapIndex.text()).includes(`<loc>${origin}/sitemaps/content.xml</loc>`))
  const indexedWithdraw = await request(`${indexedPath}/withdraw`, 'POST', {
    action: 'withdraw',
    expectedRevision: indexedRelease.revision,
    expectedVersion: indexedDraft.pageVersion,
    reason: 'Explicit isolated sitemap release withdrawal'
  })
  assert.equal(indexedWithdraw.status, 200)
  assert.equal(cmsPublicationReceiptSchema.parse(await indexedWithdraw.json()).publicationId, null)
  const sitemapAfter = await request('/sitemaps/content.xml', 'GET', undefined, '')
  assert.equal(sitemapAfter.status, 200)
  assert(!(await sitemapAfter.text()).includes(indexedLocation))
  assert.equal((await request(`/api/content/${indexedSlug}`, 'GET', undefined, '')).status, 404)
  assert.equal(
    (await database.prepare('SELECT count(*) AS n FROM content_publication_guards').first<{ n: number }>())?.n,
    0
  )
  scenarios++
  return { scenarios }
}
