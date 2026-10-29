import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cmsPublicationStateSchema } from '../../shared/cms-publication'
import {
  cmsCommandReceiptSchema,
  cmsPageDetailSchema,
  cmsPageListSchema,
  type CmsCommandReceipt
} from '../../shared/cms-commands'

export interface NativeCmsDraftAuditInput {
  /** Adapt the existing isolated workerd dispatch; never provide network fetch. */
  dispatch: (request: Request) => Promise<Response>
  database: D1Database
  origin: string
  adminCookie: string
  /** Existing live, MFA-verified actor without any CMS permission. */
  unprivilegedCookie: string
  /** Mark the current scenario before assertions; the return value counts passes. */
  scenario: (name: string) => void
}

/** Integration evidence against the caller's actual disposable workerd and D1.
 * It creates no identities/grants, signs no cookies, reads no configuration or
 * secrets, invokes no providers and never changes a published-content pointer.
 * It only issues scoped draft writes through the private HTTP API; normal
 * platform abuse-control bookkeeping remains part of that real request path.
 */
export async function auditNativeCmsDrafts(input: NativeCmsDraftAuditInput): Promise<{ scenarios: number }> {
  const { dispatch, database, origin, adminCookie, unprivilegedCookie, scenario } = input
  const localOrigin = new URL(origin)
  assert.equal(localOrigin.origin, origin)
  assert.equal(localOrigin.protocol, 'https:')
  assert(
    localOrigin.hostname.endsWith('.invalid') || origin === 'https://shop-audit.neteco.test',
    'CMS audit requires an isolated fixture origin'
  )
  assert(adminCookie && unprivilegedCookie && adminCookie !== unprivilegedCookie)

  const root = '/api/admin/content/pages'
  const nonce = randomUUID()
  const slug = `cms-audit-${nonce}`
  const renamedSlug = `${slug}-edit`
  const title = `Borrador aislado ${nonce}`
  const privateMarker = `cms-private-workerd-${nonce}`
  const document = {
    title,
    slug,
    blocks: [{ id: randomUUID(), type: 'paragraph', text: privateMarker }],
    seo: {
      title: 'Borrador editorial aislado',
      description: 'Contenido sintético privado de auditoría local.',
      noindex: true
    },
    changeSummary: 'Synthetic initial draft in isolated workerd'
  }
  const createInput = { ...document, expectedVersion: 0 }
  const createKey = randomUUID()
  let scenarios = 0

  function request(path: string, method = 'GET', cookie = adminCookie, body?: unknown, key?: string) {
    const target = new URL(path, origin)
    assert.equal(target.origin, origin)
    assert(path.startsWith('/'), 'The audit only dispatches local absolute paths')
    const headers: Record<string, string> = {
      origin,
      'cf-connecting-ip': '192.0.2.144',
      ...(cookie ? { cookie } : {})
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (key !== undefined) headers['idempotency-key'] = key
    return dispatch(
      new Request(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      })
    )
  }
  function privateHeaders(response: Response) {
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('vary'), 'Cookie')
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.match(response.headers.get('content-type') ?? '', /application\/json/i)
  }
  async function mutation(path: string, method: string, body: unknown, key: string, status: number) {
    const response = await request(path, method, adminCookie, body, key)
    assert.equal(response.status, status)
    privateHeaders(response)
    const text = await response.text()
    return { text, receipt: cmsCommandReceiptSchema.parse(JSON.parse(text)) }
  }
  async function denied(response: Response, status: number, code: string) {
    assert.equal(response.status, status)
    privateHeaders(response)
    assert.deepEqual(await response.json(), { error: { code } })
  }
  async function counts(pageId?: string) {
    const filters = pageId === undefined ? '' : ' WHERE page_id=?1'
    const command = database.prepare(`SELECT
      (SELECT count(*) FROM content_draft_commands${filters}) AS commands,
      (SELECT count(*) FROM content_draft_audit${filters}) AS audits,
      (SELECT count(*) FROM content_versions${filters}) AS versions,
      (SELECT count(*) FROM content_slug_claims${filters}) AS slugs,
      (SELECT count(*) FROM content_draft_guards) AS guards`)
    const row = await (pageId === undefined ? command : command.bind(pageId)).first<{
      commands: number
      audits: number
      versions: number
      slugs: number
      guards: number
    }>()
    assert(row)
    return row
  }
  async function detail(pageId: string) {
    const response = await request(`${root}/${pageId}`)
    assert.equal(response.status, 200)
    privateHeaders(response)
    const value = cmsPageDetailSchema.parse(await response.json())
    assert.equal(value.page.id, pageId)
    return value
  }
  async function publicHidden(paths: string[], forbiddenText: string[]) {
    for (const path of paths) {
      // Neither a draft nor an archived snapshot becomes public through the
      // historical Node API or the generated Nitro content renderer.
      const response = await request(path, 'GET', '')
      assert.equal(response.status, 404)
      const text = await response.text()
      for (const forbidden of forbiddenText) assert(!text.includes(forbidden), 'Private CMS content escaped its reader')
      if (path.startsWith('/api/')) assert(!/text\/html/i.test(response.headers.get('content-type') ?? ''))
    }
  }
  function matchesReceipt(
    receipt: CmsCommandReceipt,
    action: CmsCommandReceipt['action'],
    pageId: string,
    pageVersion: number,
    draftVersion: number,
    expectedSlug: string
  ) {
    assert.equal(receipt.source, 'cloudflare')
    assert.equal(receipt.action, action)
    assert.equal(receipt.pageId, pageId)
    assert.equal(receipt.pageVersion, pageVersion)
    assert.equal(receipt.draftVersion, draftVersion)
    assert.equal(receipt.slug, expectedSlug)
    assert.equal(receipt.status, action === 'archive_draft' ? 'hidden' : 'draft')
    assert.equal(receipt.updated, true)
  }

  scenario('real_d1_cms_unprivileged_actor_denied_without_effects')
  const beforeDenied = await counts()
  await denied(await request(root, 'GET', unprivilegedCookie), 403, 'forbidden')
  await denied(await request(root, 'POST', unprivilegedCookie, createInput, createKey), 403, 'forbidden')
  assert.deepEqual(await counts(), beforeDenied)
  scenarios++

  scenario('real_d1_cms_create_private_version_and_immutable_owned_audit')
  const created = await mutation(root, 'POST', createInput, createKey, 201)
  const pageId = created.receipt.pageId
  const path = `${root}/${pageId}`
  matchesReceipt(created.receipt, 'create_draft', pageId, 1, 1, slug)
  assert.deepEqual(await counts(pageId), { commands: 1, audits: 1, versions: 1, slugs: 1, guards: 0 })
  const createAudit = await database
    .prepare(
      `SELECT c.id,c.claim_nonce,c.actor_id,c.response,
    a.command_id,a.actor_id AS audit_actor,a.response AS audit_response,
    c.after_revision=a.after_revision AND c.after_state=a.after_state AND c.input=a.input
      AND c.target=a.target AND c.reason=a.reason AND c.created_at=a.created_at AS matching
    FROM content_draft_commands c JOIN content_draft_audit a ON a.command_id=c.id WHERE c.page_id=?1`
    )
    .bind(pageId)
    .first<{
      id: string
      claim_nonce: string
      actor_id: string
      response: string
      command_id: string
      audit_actor: string
      audit_response: string
      matching: number
    }>()
  assert(createAudit)
  assert.equal(createAudit.id, createAudit.command_id)
  assert.notEqual(createAudit.id, createAudit.claim_nonce)
  assert.equal(createAudit.actor_id, createAudit.audit_actor)
  assert.equal(createAudit.response, createAudit.audit_response)
  assert.equal(createAudit.matching, 1)
  scenarios++

  scenario('real_d1_cms_confirmed_private_list_detail_and_closed_publication_capabilities')
  const listedResponse = await request(`${root}?perPage=100`)
  assert.equal(listedResponse.status, 200)
  privateHeaders(listedResponse)
  const listed = cmsPageListSchema.parse(await listedResponse.json())
  assert(listed.pages.some((page) => page.id === pageId && page.draftVersionId === created.receipt.versionId))
  const initial = await detail(pageId)
  assert.deepEqual(initial.draft.document, document)
  assert.equal(initial.page.pageVersion, 1)
  assert.equal(initial.draft.createdBy, createAudit.actor_id)
  const editorialResponse = await request(`${root}/${pageId}/publication`)
  assert.equal(editorialResponse.status, 200)
  privateHeaders(editorialResponse)
  const editorial = cmsPublicationStateSchema.parse(await editorialResponse.json())
  assert.equal(editorial.pageId, pageId)
  assert.deepEqual(initial.capabilities, {
    contentRead: true,
    contentCreate: true,
    contentUpdate: true,
    contentRestore: true,
    contentArchive: true,
    contentPublish: editorial.capabilities.publish,
    contentPreview: editorial.capabilities.preview,
    contentSchedule: editorial.capabilities.schedule
  })
  assert.equal(initial.history.versions.length, 1)
  await publicHidden([`/api/content/${slug}`, `/contenido/${slug}`], [privateMarker, title])
  scenarios++

  scenario('real_d1_cms_update_appends_version_and_reserves_historical_slug')
  const updateInput = {
    ...document,
    title: `${title} editado`,
    slug: renamedSlug,
    blocks: [{ ...document.blocks[0]!, text: `${privateMarker}:edited` }],
    changeSummary: 'Synthetic version append in isolated workerd',
    expectedVersion: 1
  }
  const updateKey = randomUUID()
  const updated = await mutation(path, 'PUT', updateInput, updateKey, 200)
  matchesReceipt(updated.receipt, 'update_draft', pageId, 2, 2, renamedSlug)
  assert.notEqual(updated.receipt.versionId, created.receipt.versionId)
  const afterUpdate = await detail(pageId)
  assert.equal(afterUpdate.page.pageVersion, 2)
  assert.equal(afterUpdate.draft.document.title, updateInput.title)
  assert.equal(afterUpdate.draft.basedOnId, created.receipt.versionId)
  assert.deepEqual(
    afterUpdate.history.versions.map((version) => version.version),
    [2, 1]
  )
  assert.deepEqual(afterUpdate.history.versions[1]!.document, document)
  const claims = await database
    .prepare('SELECT slug,page_id FROM content_slug_claims WHERE page_id=? ORDER BY slug')
    .bind(pageId)
    .all<{ slug: string; page_id: string }>()
  assert.equal(claims.success, true)
  assert.deepEqual(claims.results, [
    { slug, page_id: pageId },
    { slug: renamedSlug, page_id: pageId }
  ])
  await publicHidden(
    [`/api/content/${slug}`, `/api/content/${renamedSlug}`, `/contenido/${renamedSlug}`],
    [privateMarker, title, updateInput.title]
  )
  scenarios++

  scenario('real_d1_cms_stale_cas_rejected_without_revision_or_audit')
  const beforeStale = await counts(pageId)
  await denied(await request(path, 'PUT', adminCookie, updateInput, randomUUID()), 409, 'version_conflict')
  assert.deepEqual(await counts(pageId), beforeStale)
  assert.equal((await detail(pageId)).page.pageVersion, 2)
  scenarios++

  scenario('real_d1_cms_restore_creates_new_draft_and_preserves_every_prior_version')
  const restoreInput = {
    expectedVersion: 2,
    versionId: created.receipt.versionId,
    reason: 'Synthetic contextual draft restoration'
  }
  const restoreKey = randomUUID()
  const restored = await mutation(`${path}/rollback`, 'POST', restoreInput, restoreKey, 200)
  matchesReceipt(restored.receipt, 'restore_draft', pageId, 3, 3, slug)
  assert.notEqual(restored.receipt.versionId, created.receipt.versionId)
  assert.notEqual(restored.receipt.versionId, updated.receipt.versionId)
  const afterRestore = await detail(pageId)
  assert.deepEqual(afterRestore.draft.document, { ...document, changeSummary: restoreInput.reason })
  assert.equal(afterRestore.draft.basedOnId, created.receipt.versionId)
  assert.deepEqual(
    afterRestore.history.versions.map((version) => version.id),
    [restored.receipt.versionId, updated.receipt.versionId, created.receipt.versionId]
  )
  scenarios++

  scenario('real_d1_cms_archive_preserves_draft_identity_history_and_reserved_slugs')
  const archiveInput = { expectedVersion: 3, reason: 'Synthetic recoverable draft archival' }
  const archiveKey = randomUUID()
  const archived = await mutation(path, 'DELETE', archiveInput, archiveKey, 200)
  matchesReceipt(archived.receipt, 'archive_draft', pageId, 4, 3, slug)
  assert.equal(archived.receipt.versionId, restored.receipt.versionId)
  const afterArchive = await detail(pageId)
  assert.equal(afterArchive.page.status, 'hidden')
  assert(afterArchive.page.archivedAt)
  assert.equal(afterArchive.draft.id, restored.receipt.versionId)
  assert.deepEqual(afterArchive.history.versions, afterRestore.history.versions)
  assert.deepEqual(await counts(pageId), { commands: 4, audits: 4, versions: 3, slugs: 2, guards: 0 })
  scenarios++

  scenario('real_d1_cms_historical_identical_replay_and_payload_conflict_after_archival')
  const beforeReplay = await counts(pageId)
  for (const command of [
    { path: root, method: 'POST', body: createInput, key: createKey, original: created, status: 201 },
    { path, method: 'PUT', body: updateInput, key: updateKey, original: updated, status: 200 },
    { path: `${path}/rollback`, method: 'POST', body: restoreInput, key: restoreKey, original: restored, status: 200 },
    { path, method: 'DELETE', body: archiveInput, key: archiveKey, original: archived, status: 200 }
  ]) {
    const replayed = await mutation(command.path, command.method, command.body, command.key, command.status)
    assert.equal(replayed.text, command.original.text)
  }
  await denied(
    await request(root, 'POST', adminCookie, { ...createInput, title: `${title} distinto` }, createKey),
    409,
    'idempotency_conflict'
  )
  assert.deepEqual(await counts(pageId), beforeReplay)
  assert.equal((await detail(pageId)).page.pageVersion, 4)
  scenarios++

  scenario('real_d1_cms_publication_rejects_legacy_unversioned_bodies_without_fallback')
  const beforePublication = await counts(pageId)
  for (const suffix of ['publish', 'preview', 'schedule'])
    await denied(
      await request(
        `${path}/${suffix}`,
        'POST',
        adminCookie,
        { reason: 'Never publish from a draft audit' },
        randomUUID()
      ),
      422,
      'invalid_input'
    )
  assert.deepEqual(await counts(pageId), beforePublication)
  assert.equal((await detail(pageId)).page.status, 'hidden')
  scenarios++

  scenario('real_d1_cms_draft_and_archived_snapshots_never_escape_public_api_or_renderer')
  await publicHidden(
    [`/api/content/${slug}`, `/api/content/${renamedSlug}`, `/contenido/${slug}`, `/contenido/${renamedSlug}`],
    [privateMarker, title, updateInput.title]
  )
  assert.deepEqual(await counts(pageId), { commands: 4, audits: 4, versions: 3, slugs: 2, guards: 0 })
  scenarios++
  return { scenarios }
}
