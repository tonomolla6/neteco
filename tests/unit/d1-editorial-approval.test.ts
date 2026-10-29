import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_IDENTITY, CMS_SESSION, cmsDocument, cmsUtc } from './d1-cms-fixture'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import {
  createEditorialReview,
  assignReviewer,
  updateChecklistItem,
  addReviewComment,
  approveEditorialReview,
  rejectEditorialReview,
  getEditorialReview,
  EditorialApprovalError
} from '../../workers/cms/editorial-approval'
import { executeCmsPublicationCommand, CmsPublicationError } from '../../workers/cms/publication'

const PUBLISHER_IDENTITY = '10000000-0000-4000-8000-000000000099'
const PUBLISHER_SESSION = '20000000-0000-4000-8000-000000000099'
const REVIEWER_NO_PUBLISH_IDENTITY = '10000000-0000-4000-8000-000000000098'
const REVIEWER_NO_PUBLISH_SESSION = '20000000-0000-4000-8000-000000000098'

async function setupEditorialFixture() {
  const f = await cmsPublicationFixture()
  const sql0097 = await readFile(new URL('../../db/d1/migrations/0096_editorial_approval.sql', import.meta.url), 'utf8')
  f.sqlite.exec(sql0097)

  const past = cmsUtc(-86400000)
  const now = cmsUtc(0)

  // Publisher identity with catalog.publish and catalog.write
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

  // Reviewer identity with only catalog.write (no catalog.publish)
  f.sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'editor-writer@example.invalid','synthetic-only',?,'active',?,?)"
    )
    .run(REVIEWER_NO_PUBLISH_IDENTITY, past, past, past)
  f.sqlite.exec(`INSERT OR IGNORE INTO roles VALUES ('cms_author_only','Author only','Synthetic');
    INSERT OR IGNORE INTO role_permissions VALUES ('cms_author_only','catalog.write');`)
  f.sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'cms_author_only',?)")
    .run(REVIEWER_NO_PUBLISH_IDENTITY, past)
  f.sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
    )
    .run(REVIEWER_NO_PUBLISH_SESSION, REVIEWER_NO_PUBLISH_IDENTITY, now, cmsUtc(3600000))

  const authorClaims = { identityId: CMS_IDENTITY, sessionId: CMS_SESSION, sessionVersion: 1 }
  const publisherClaims = { identityId: PUBLISHER_IDENTITY, sessionId: PUBLISHER_SESSION, sessionVersion: 1 }
  const writeOnlyClaims = {
    identityId: REVIEWER_NO_PUBLISH_IDENTITY,
    sessionId: REVIEWER_NO_PUBLISH_SESSION,
    sessionVersion: 1
  }

  return { ...f, authorClaims, publisherClaims, writeOnlyClaims }
}

describe('Editorial Approval Workflow (ADM-023)', () => {
  it('initializes migration 0097 with checklist templates and tables', async () => {
    const f = await setupEditorialFixture()
    const templates = f.sqlite
      .prepare('SELECT content_type, is_critical, title FROM editorial_checklist_templates ORDER BY content_type')
      .all() as Array<{ content_type: string; is_critical: number; title: string }>
    expect(templates).toHaveLength(4)
    expect(templates.map((t) => t.content_type)).toEqual(['chemical_safety', 'general', 'legal', 'pricing'])
    expect(templates.find((t) => t.content_type === 'chemical_safety')).toMatchObject({ is_critical: 1 })
    expect(templates.find((t) => t.content_type === 'general')).toMatchObject({ is_critical: 0 })
  })

  it('creates an editorial review with populated checklist and initial status in_review', async () => {
    const f = await setupEditorialFixture()
    const pageId = f.created.pageId
    const versionId = f.created.versionId

    const result = await createEditorialReview(
      f.database,
      f.authorClaims,
      {
        pageId,
        versionId,
        contentType: 'chemical_safety',
        assignedReviewerId: PUBLISHER_IDENTITY,
        note: 'Por favor revisar FDS y pictogramas para este producto'
      },
      { idempotencyKey: crypto.randomUUID() }
    )

    expect(result.id).toBeDefined()
    expect(result.status).toBe('in_review')
    expect(result.isCritical).toBe(true)
    expect(result.assignedReviewerId).toBe(PUBLISHER_IDENTITY)
    expect(result.authorId).toBe(CMS_IDENTITY)
    expect(result.checklist).toHaveLength(3)
    expect(result.checklist.every((item) => !item.completed)).toBe(true)

    // Verify detail
    const detail = await getEditorialReview(f.database, f.publisherClaims, result.id)
    expect(detail.status).toBe('in_review')
    expect(detail.comments).toHaveLength(1)
    expect(detail.comments[0].comment).toContain('Por favor revisar FDS')
  })

  it('rejects approval when checklist is incomplete', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'chemical_safety' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Complete only 2 of 3 items
    await updateChecklistItem(
      f.database,
      f.publisherClaims,
      rev.id,
      { itemKey: 'fds_vigente', completed: true, expectedVersion: 1 },
      { idempotencyKey: crypto.randomUUID() }
    )
    await updateChecklistItem(
      f.database,
      f.publisherClaims,
      rev.id,
      { itemKey: 'pictogramas_clp', completed: true, expectedVersion: 2 },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Try approving when phrases_hp_revisadas is still incomplete
    await expect(
      approveEditorialReview(
        f.database,
        f.publisherClaims,
        rev.id,
        { expectedVersion: 3, note: 'Intento de aprobación incompleto' },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)
  })

  it('never lets the client downgrade a critical template with isCritical=false', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'legal', isCritical: false },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(rev.isCritical).toBe(true)
  })

  it('treats legal slugs as critical even when the client declares general content', async () => {
    const f = await setupEditorialFixture()
    const legal = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'create_draft',
      {},
      { ...cmsDocument({ title: 'Aviso legal', slug: 'aviso-legal' }), expectedVersion: 0 },
      { idempotencyKey: crypto.randomUUID() }
    )
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: legal.pageId, versionId: legal.versionId, contentType: 'general', isCritical: false },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(rev.isCritical).toBe(true)
  })

  it('keeps a page critical once it had a critical review, even if the client declares general later', async () => {
    const f = await setupEditorialFixture()
    const first = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'chemical_safety' },
      { idempotencyKey: crypto.randomUUID() }
    )
    await rejectEditorialReview(
      f.database,
      f.publisherClaims,
      first.id,
      { expectedVersion: first.version, reason: 'Faltan frases H/P' },
      { idempotencyKey: crypto.randomUUID() }
    )
    const second = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(second.isCritical).toBe(true)
  })

  it('enforces separation of duties: author cannot approve own critical review', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'legal' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Complete all items for legal review
    let v = 1
    for (const item of rev.checklist) {
      await updateChecklistItem(
        f.database,
        f.authorClaims,
        rev.id,
        { itemKey: item.itemKey, completed: true, expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
      v++
    }

    // Author tries to self-approve critical review
    await expect(
      approveEditorialReview(
        f.database,
        f.authorClaims,
        rev.id,
        { expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)

    // Author cannot self-approve -> error code should be author_cannot_approve
    try {
      await approveEditorialReview(
        f.database,
        f.authorClaims,
        rev.id,
        { expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
    } catch (err: unknown) {
      expect((err as EditorialApprovalError).code).toBe('author_cannot_approve')
    }
  })

  it('allows auto-approval for non-critical content when publisher role is held', async () => {
    const f = await setupEditorialFixture()
    // Non-critical review created by publisher
    const rev = await createEditorialReview(
      f.database,
      f.publisherClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(rev.isCritical).toBe(false)

    // Complete checklist
    let v = 1
    for (const item of rev.checklist) {
      await updateChecklistItem(
        f.database,
        f.publisherClaims,
        rev.id,
        { itemKey: item.itemKey, completed: true, expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
      v++
    }

    // Self-approval allowed for non-critical
    const approved = await approveEditorialReview(
      f.database,
      f.publisherClaims,
      rev.id,
      { expectedVersion: v, note: 'Autoaprobado cambio no crítico de estilo' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe(PUBLISHER_IDENTITY)
  })

  it('rejects approval if reviewer lacks catalog.publish permission', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )

    let v = 1
    for (const item of rev.checklist) {
      await updateChecklistItem(
        f.database,
        f.writeOnlyClaims,
        rev.id,
        { itemKey: item.itemKey, completed: true, expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
      v++
    }

    // writeOnlyClaims lacks catalog.publish
    await expect(
      approveEditorialReview(
        f.database,
        f.writeOnlyClaims,
        rev.id,
        { expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)
  })

  it('rejects approval or critical publication when MFA is expired', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'pricing' },
      { idempotencyKey: crypto.randomUUID() }
    )

    let v = 1
    for (const item of rev.checklist) {
      await updateChecklistItem(
        f.database,
        f.publisherClaims,
        rev.id,
        { itemKey: item.itemKey, completed: true, expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
      v++
    }

    // Age the publisher's session by 2 hours
    const expiredInstant = cmsUtc(-7200000)
    f.sqlite.prepare('UPDATE auth_sessions SET created_at = ? WHERE id = ?').run(expiredInstant, PUBLISHER_SESSION)

    await expect(
      approveEditorialReview(
        f.database,
        f.publisherClaims,
        rev.id,
        { expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)

    try {
      await approveEditorialReview(
        f.database,
        f.publisherClaims,
        rev.id,
        { expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
    } catch (err: unknown) {
      expect((err as EditorialApprovalError).code).toBe('mfa_expired')
    }
  })

  it('rejects invalid state transitions', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Reject review with valid reason
    const rejected = await rejectEditorialReview(
      f.database,
      f.publisherClaims,
      rev.id,
      { expectedVersion: 1, reason: 'Información desactualizada' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(rejected.status).toBe('rejected')

    // Cannot approve directly from rejected without moving back to in_review
    await expect(
      approveEditorialReview(
        f.database,
        f.publisherClaims,
        rev.id,
        { expectedVersion: 2 },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)
  })

  it('enforces append-only immutable comments (triggers abort update and delete)', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )

    const comment = await addReviewComment(
      f.database,
      f.authorClaims,
      rev.id,
      { comment: 'Primer comentario inmutable' },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect(comment.id).toBeDefined()

    // Database triggers must forbid UPDATE and DELETE
    expect(() => {
      f.sqlite
        .prepare('UPDATE editorial_review_comments SET comment = ? WHERE id = ?')
        .run('Modificado maliciosamente', comment.id)
    }).toThrow(/editorial_comment_immutable/)

    expect(() => {
      f.sqlite.prepare('DELETE FROM editorial_review_comments WHERE id = ?').run(comment.id)
    }).toThrow(/editorial_comment_immutable/)
  })

  it('enforces CAS version concurrency conflict', async () => {
    const f = await setupEditorialFixture()
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Update with wrong expectedVersion
    await expect(
      assignReviewer(
        f.database,
        f.authorClaims,
        rev.id,
        { assignedReviewerId: PUBLISHER_IDENTITY, expectedVersion: 99 },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).rejects.toThrow(EditorialApprovalError)
  })

  it('replays identical command responses idempotently', async () => {
    const f = await setupEditorialFixture()
    const key = crypto.randomUUID()
    const first = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: key }
    )
    const second = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId: f.created.pageId, versionId: f.created.versionId, contentType: 'general' },
      { idempotencyKey: key }
    )
    expect(second.id).toBe(first.id)
    expect(second.status).toBe(first.status)
  })

  it('blocks publication when version has pending review; allows when approved', async () => {
    const f = await setupEditorialFixture()
    const pageId = f.created.pageId
    const versionId = f.created.versionId

    // Create review -> status in_review
    const rev = await createEditorialReview(
      f.database,
      f.authorClaims,
      { pageId, versionId, contentType: 'chemical_safety' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Try publishing while in_review -> should fail
    const publishInput = {
      action: 'publish' as const,
      expectedVersion: 1,
      expectedRevision: 0,
      versionId,
      reason: 'Intento de publicación prematura'
    }

    await expect(
      executeCmsPublicationCommand(f.deps, f.publisherClaims, pageId, publishInput, crypto.randomUUID())
    ).rejects.toThrow(CmsPublicationError)

    // Complete checklist
    let v = 1
    for (const item of rev.checklist) {
      await updateChecklistItem(
        f.database,
        f.publisherClaims,
        rev.id,
        { itemKey: item.itemKey, completed: true, expectedVersion: v },
        { idempotencyKey: crypto.randomUUID() }
      )
      v++
    }

    // Publisher approves review
    await approveEditorialReview(
      f.database,
      f.publisherClaims,
      rev.id,
      { expectedVersion: v, note: 'Revisión técnica aprobada' },
      { idempotencyKey: crypto.randomUUID() }
    )

    // Critical change: author still cannot publish own change
    await expect(
      executeCmsPublicationCommand(f.deps, f.authorClaims, pageId, publishInput, crypto.randomUUID())
    ).rejects.toThrow(CmsPublicationError)

    // Different publisher can publish
    const receipt = await executeCmsPublicationCommand(
      f.deps,
      f.publisherClaims,
      pageId,
      publishInput,
      crypto.randomUUID()
    )
    expect(receipt.updated).toBe(true)

    // Review status transitions to published
    const finalReview = await getEditorialReview(f.database, f.publisherClaims, rev.id)
    expect(finalReview.status).toBe('published')
    expect(finalReview.publishedBy).toBe(PUBLISHER_IDENTITY)
  })
})
