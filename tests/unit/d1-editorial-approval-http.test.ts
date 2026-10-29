import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_IDENTITY, CMS_SESSION, cmsUtc } from './d1-cms-fixture'
import { handleEditorialApprovalHttp } from '../../workers/cms/editorial-approval-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import type { CmsDraftHttpEnvironment } from '../../workers/cms/http'

const PUBLISHER_IDENTITY = '10000000-0000-4000-8000-000000000099'
const PUBLISHER_SESSION = '20000000-0000-4000-8000-000000000099'
const SESSION_PASSWORD = 'k'.repeat(32)
const ORIGIN = 'https://admin.neteco.invalid'

async function setupHttpFixture() {
  const f = await cmsPublicationFixture()
  const sql0097 = await readFile(new URL('../../db/d1/migrations/0096_editorial_approval.sql', import.meta.url), 'utf8')
  f.sqlite.exec(sql0097)

  const past = cmsUtc(-86400000)
  const now = cmsUtc(0)

  // Publisher identity
  f.sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'publisher@example.invalid','synthetic-only',?,'active',?,?)"
    )
    .run(PUBLISHER_IDENTITY, past, past, past)
  f.sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'cms_editor',?)")
    .run(PUBLISHER_IDENTITY, past)
  f.sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
    )
    .run(PUBLISHER_SESSION, PUBLISHER_IDENTITY, now, cmsUtc(3600000))

  const authorCookie = (await issueD1SessionCookie(
    f.database,
    { sessionId: CMS_SESSION, identityId: CMS_IDENTITY, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  ))!.split(';')[0]!
  const publisherCookie = (await issueD1SessionCookie(
    f.database,
    { sessionId: PUBLISHER_SESSION, identityId: PUBLISHER_IDENTITY, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  ))!.split(';')[0]!

  const env: CmsDraftHttpEnvironment = {
    DB: f.database,
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: ORIGIN,
    NUXT_SESSION_PASSWORD: SESSION_PASSWORD
  }

  function req(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = authorCookie,
    idempotencyKey = crypto.randomUUID()
  ) {
    const headers: Record<string, string> = {
      Origin: ORIGIN,
      Cookie: cookie ?? ''
    }
    if (idempotencyKey && method !== 'GET') headers['idempotency-key'] = idempotencyKey
    if (body !== undefined) headers['content-type'] = 'application/json'

    return new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
  }

  return { ...f, env, req, authorCookie, publisherCookie }
}

describe('Editorial Approval HTTP API', () => {
  it('returns 401 for unauthenticated requests', async () => {
    const f = await setupHttpFixture()
    const request = f.req('/api/admin/content/editorial-reviews', 'GET', undefined, '')
    const response = await handleEditorialApprovalHttp(request, f.env)
    expect(response?.status).toBe(401)
  })

  it('lists checklist templates at /api/admin/content/editorial-reviews/templates', async () => {
    const f = await setupHttpFixture()
    const request = f.req('/api/admin/content/editorial-reviews/templates')
    const response = await handleEditorialApprovalHttp(request, f.env)
    expect(response?.status).toBe(200)
    const data = await response?.json()
    expect(data.templates).toHaveLength(4)
  })

  it('creates, inspects, updates checklist, and approves review over HTTP', async () => {
    const f = await setupHttpFixture()
    const pageId = f.created.pageId
    const versionId = f.created.versionId

    // 1. POST create review
    const createReq = f.req(
      '/api/admin/content/editorial-reviews',
      'POST',
      {
        pageId,
        versionId,
        contentType: 'general',
        assignedReviewerId: PUBLISHER_IDENTITY,
        note: 'Por favor revisar cambios de texto'
      },
      f.authorCookie
    )
    const createRes = await handleEditorialApprovalHttp(createReq, f.env)
    expect(createRes?.status).toBe(201)
    const created = await createRes?.json()
    expect(created.id).toBeDefined()
    expect(created.status).toBe('in_review')
    expect(created.checklist).toHaveLength(2)

    // 2. GET review list
    const listReq = f.req('/api/admin/content/editorial-reviews?status=in_review')
    const listRes = await handleEditorialApprovalHttp(listReq, f.env)
    expect(listRes?.status).toBe(200)
    const listData = await listRes?.json()
    expect(listData.items.length).toBeGreaterThanOrEqual(1)

    // 3. GET review detail with diff
    const detailReq = f.req(`/api/admin/content/editorial-reviews/${created.id}`)
    const detailRes = await handleEditorialApprovalHttp(detailReq, f.env)
    expect(detailRes?.status).toBe(200)
    const detail = await detailRes?.json()
    expect(detail.id).toBe(created.id)
    expect(detail.diff.proposedVersionId).toBe(versionId)

    // 4. POST add comment
    const commentReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/comments`,
      'POST',
      { comment: 'Verificado el primer párrafo' },
      f.publisherCookie
    )
    const commentRes = await handleEditorialApprovalHttp(commentReq, f.env)
    expect(commentRes?.status).toBe(201)

    // 5. POST update checklist items
    let curVer = 1
    for (const item of created.checklist) {
      const checkReq = f.req(
        `/api/admin/content/editorial-reviews/${created.id}/checklist`,
        'POST',
        { itemKey: item.itemKey, completed: true, expectedVersion: curVer },
        f.publisherCookie
      )
      const checkRes = await handleEditorialApprovalHttp(checkReq, f.env)
      expect(checkRes?.status).toBe(200)
      curVer++
    }

    // 6. POST approve
    const approveReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/approve`,
      'POST',
      { expectedVersion: curVer, note: 'Aprobado sin objeciones' },
      f.publisherCookie
    )
    const approveRes = await handleEditorialApprovalHttp(approveReq, f.env)
    expect(approveRes?.status).toBe(200)
    const approved = await approveRes?.json()
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe(PUBLISHER_IDENTITY)
  })

  it('rejects critical self-approval with 403', async () => {
    const f = await setupHttpFixture()
    const pageId = f.created.pageId
    const versionId = f.created.versionId

    // Create critical review
    const createReq = f.req(
      '/api/admin/content/editorial-reviews',
      'POST',
      { pageId, versionId, contentType: 'legal' },
      f.authorCookie
    )
    const createRes = await handleEditorialApprovalHttp(createReq, f.env)
    expect(createRes?.status).toBe(201)
    const created = await createRes?.json()

    // Complete checklist
    let curVer = 1
    for (const item of created.checklist) {
      const checkReq = f.req(
        `/api/admin/content/editorial-reviews/${created.id}/checklist`,
        'POST',
        { itemKey: item.itemKey, completed: true, expectedVersion: curVer },
        f.authorCookie
      )
      await handleEditorialApprovalHttp(checkReq, f.env)
      curVer++
    }

    // Author tries to approve critical review
    const approveReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/approve`,
      'POST',
      { expectedVersion: curVer },
      f.authorCookie
    )
    const approveRes = await handleEditorialApprovalHttp(approveReq, f.env)
    expect(approveRes?.status).toBe(403)
    const errorBody = await approveRes?.json()
    expect(errorBody.error.code).toBe('author_cannot_approve')
  })

  it('handles reviewer assignment, rejection with reason, and withdrawal over HTTP', async () => {
    const f = await setupHttpFixture()
    const pageId = f.created.pageId
    const versionId = f.created.versionId

    // Create review
    const createReq = f.req(
      '/api/admin/content/editorial-reviews',
      'POST',
      { pageId, versionId, contentType: 'pricing' },
      f.authorCookie
    )
    const createRes = await handleEditorialApprovalHttp(createReq, f.env)
    expect(createRes?.status).toBe(201)
    const created = await createRes?.json()

    // Assign reviewer
    const assignReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/assign`,
      'POST',
      { assignedReviewerId: PUBLISHER_IDENTITY, expectedVersion: 1 },
      f.authorCookie
    )
    const assignRes = await handleEditorialApprovalHttp(assignReq, f.env)
    expect(assignRes?.status).toBe(200)
    const assigned = await assignRes?.json()
    expect(assigned.assignedReviewerId).toBe(PUBLISHER_IDENTITY)
    expect(assigned.version).toBe(2)

    // Reject review with motive
    const rejectReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/reject`,
      'POST',
      { expectedVersion: 2, reason: 'Los precios no incluyen el IVA aplicable' },
      f.publisherCookie
    )
    const rejectRes = await handleEditorialApprovalHttp(rejectReq, f.env)
    expect(rejectRes?.status).toBe(200)
    const rejected = await rejectRes?.json()
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('Los precios no incluyen el IVA aplicable')
    expect(rejected.version).toBe(3)

    // Withdraw review
    const withdrawReq = f.req(
      `/api/admin/content/editorial-reviews/${created.id}/withdraw`,
      'POST',
      { expectedVersion: 3, reason: 'Borrador descartado por dirección' },
      f.authorCookie
    )
    const withdrawRes = await handleEditorialApprovalHttp(withdrawReq, f.env)
    expect(withdrawRes?.status).toBe(200)
    const withdrawn = await withdrawRes?.json()
    expect(withdrawn.status).toBe('withdrawn')
  })

  it('rejects cross-site CSRF requests', async () => {
    const f = await setupHttpFixture()
    const request = new Request(`${ORIGIN}/api/admin/content/editorial-reviews`, {
      method: 'POST',
      headers: {
        Origin: 'https://attacker.invalid',
        Cookie: f.authorCookie,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID()
      },
      body: JSON.stringify({ pageId: f.created.pageId, versionId: f.created.versionId })
    })
    const response = await handleEditorialApprovalHttp(request, f.env)
    expect(response?.status).toBe(403)
    const data = await response?.json()
    expect(data.error.code).toBe('csrf_rejected')
  })
})
