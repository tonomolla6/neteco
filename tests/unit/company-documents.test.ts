import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  lifecycleFixture,
  CLAIMS,
  OTHER_CLAIMS,
  OPTIONS,
  NOW,
  COMPANY,
  AGENT_CLAIMS
} from './account-lifecycle-fixture'
import {
  addD1CompanyDocument,
  listD1CompanyDocuments,
  listD1CompanyDocumentsForReview,
  removeD1CompanyDocument
} from '../../workers/auth/company-documents'
import { executeD1CompanyReview } from '../../workers/auth/admin-companies'

let f: Awaited<ReturnType<typeof lifecycleFixture>>
beforeEach(async () => {
  f = await lifecycleFixture()
})
afterEach(() => f.sqlite.close())
const key = (n: string) => deterministicUuid(`cd-${n}`)
const sha = (c: string) => c.repeat(64)
const doc = (over: Record<string, unknown> = {}) => ({
  kind: 'tax_certificate',
  fileName: 'certificado-censal.pdf',
  contentType: 'application/pdf',
  sizeBytes: 120000,
  sha256: sha('a'),
  ...over
})
const add = (k: string, body: unknown, claims = CLAIMS) =>
  addD1CompanyDocument(f.database, claims, key(k), body, OPTIONS)
const rows = () =>
  f.sqlite.prepare('SELECT * FROM company_documents ORDER BY created_at,id').all() as Record<string, unknown>[]
// A reviewer: administration.manage + MFA, as required by the existing company review.
function reviewer() {
  f.row(
    `INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${AGENT_CLAIMS.identityId}','lifecycle-admin','2020-01-01T00:00:00Z')`
  )
}
beforeEach(() => {
  f.row(`INSERT INTO roles VALUES('lifecycle-admin','Admin','Synthetic');
 INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic');
 INSERT INTO role_permissions VALUES('lifecycle-admin','administration.manage')`)
})

describe('CUS-016 optional company documents', () => {
  it('registers an optional document for the own pending company (metadata only, no content)', async () => {
    const receipt = await add('a', doc())
    expect(receipt).toMatchObject({
      companyId: COMPANY,
      kind: 'tax_certificate',
      fileName: 'certificado-censal.pdf',
      status: 'active'
    })
    expect(JSON.stringify(receipt)).not.toContain('content"')
    expect((await listD1CompanyDocuments(f.database, CLAIMS, OPTIONS)).documents).toHaveLength(1)
  })
  it('is optional: a company with no documents lists none and stays reviewable', async () => {
    const list = await listD1CompanyDocuments(f.database, CLAIMS, OPTIONS)
    expect(list).toMatchObject({ companyStatus: 'pending', documents: [], limit: 5 })
  })
  it('replays the same key and rejects the same key with a different payload', async () => {
    const first = await add('k', doc())
    expect(await add('k', doc())).toEqual(first)
    await expect(add('k', doc({ sha256: sha('b') }))).rejects.toMatchObject({ code: 'conflict' })
    expect(rows()).toHaveLength(1)
  })
  it('refuses a duplicate active file hash under another key', async () => {
    await add('one', doc())
    await expect(add('two', doc({ fileName: 'copia.pdf' }))).rejects.toMatchObject({ code: 'conflict' })
  })
  it('limits active documents to five and frees a slot on removal', async () => {
    for (const c of 'abcde') await add(`d${c}`, doc({ sha256: sha(c), fileName: `d${c}.pdf` }))
    await expect(add('six', doc({ sha256: sha('f'), fileName: 'f.pdf' }))).rejects.toMatchObject({
      code: 'limit_reached'
    })
    const first = (await listD1CompanyDocuments(f.database, CLAIMS, OPTIONS)).documents[0]!
    await removeD1CompanyDocument(f.database, CLAIMS, first.id, OPTIONS)
    expect(await add('six', doc({ sha256: sha('f'), fileName: 'f.pdf' }))).toMatchObject({ status: 'active' })
  })
  it.each([
    ['unknown kind', { kind: 'selfie' }],
    ['bad content type', { contentType: 'application/x-msdownload' }],
    ['extension not matching content type', { fileName: 'cert.exe' }],
    ['path in file name', { fileName: '../etc/passwd.pdf' }],
    ['backslash in file name', { fileName: 'a\\b.pdf' }],
    ['control char in file name', { fileName: 'a\u0000.pdf' }],
    ['empty file', { sizeBytes: 0 }],
    ['file over 10 MiB', { sizeBytes: 10485761 }],
    ['non integer size', { sizeBytes: 1.5 }],
    ['short hash', { sha256: 'abc' }],
    ['uppercase hash', { sha256: 'A'.repeat(64) }],
    ['extra field', { content: 'AAAA' }]
  ])('rejects %s', async (_n, over) => {
    await expect(add('bad', doc(over))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(rows()).toHaveLength(0)
  })
  it('accepts jpeg and png evidence with matching extensions', async () => {
    await add('j', doc({ contentType: 'image/jpeg', fileName: 'escritura.JPG', sha256: sha('c') }))
    await add('p', doc({ contentType: 'image/png', fileName: 'sello.png', sha256: sha('d') }))
    expect(rows()).toHaveLength(2)
  })
  it('requires the customer to own a company', async () => {
    await expect(add('o', doc(), OTHER_CLAIMS)).rejects.toMatchObject({ code: 'not_found' })
  })
  it('is locked once the company is approved and open again if it is rejected or suspended', async () => {
    reviewer()
    f.row('UPDATE auth_sessions SET mfa_verified=1')
    const review = (k: string, expectedChangeId: string | null, expectedStatus: string, status: string) =>
      executeD1CompanyReview(
        f.database,
        AGENT_CLAIMS,
        COMPANY,
        key(k),
        { expectedChangeId, expectedStatus, status, reason: 'Revisión documentada sintética' } as never,
        OPTIONS
      )
    await review('approve', null, 'pending', 'approved')
    await expect(add('late', doc())).rejects.toMatchObject({ code: 'locked' })
    await review('suspend', key('approve'), 'approved', 'suspended')
    expect(await add('again', doc())).toMatchObject({ status: 'active' })
  })
  it('removes a document recording who removed it, idempotently, and never deletes the row', async () => {
    const created = await add('a', doc())
    const removed = await removeD1CompanyDocument(f.database, CLAIMS, created.id, OPTIONS)
    expect(removed).toMatchObject({ id: created.id, status: 'removed', removedAt: NOW })
    expect(await removeD1CompanyDocument(f.database, CLAIMS, created.id, OPTIONS)).toEqual(removed)
    expect(rows()).toHaveLength(1)
    expect((await listD1CompanyDocuments(f.database, CLAIMS, OPTIONS)).documents).toHaveLength(0)
    expect(() => f.sqlite.exec('DELETE FROM company_documents')).toThrow(/immutable/)
    expect(() => f.sqlite.exec("UPDATE company_documents SET sha256='" + sha('e') + "'")).toThrow(/immutable/)
  })
  it('does not let another customer remove or see a document', async () => {
    const created = await add('a', doc())
    await expect(removeD1CompanyDocument(f.database, OTHER_CLAIMS, created.id, OPTIONS)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(removeD1CompanyDocument(f.database, CLAIMS, 'not-a-uuid', OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
    expect(rows()[0]!.removed_at).toBeNull()
  })
  it('requires a live session and verified email', async () => {
    await expect(addD1CompanyDocument(f.database, null, key('a'), doc(), OPTIONS)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    f.row(`UPDATE identities SET email_verified_at=NULL WHERE id='${CLAIMS.identityId}'`)
    await expect(add('a', doc())).rejects.toMatchObject({ code: 'email_unverified' })
  })
  it('lets an authorised reviewer list active and removed documents with the responsible identity', async () => {
    reviewer()
    f.row('UPDATE auth_sessions SET mfa_verified=1')
    const first = await add('a', doc()),
      second = await add('b', doc({ sha256: sha('b'), fileName: 'b.pdf' }))
    await removeD1CompanyDocument(f.database, CLAIMS, second.id, OPTIONS)
    const review = await listD1CompanyDocumentsForReview(f.database, AGENT_CLAIMS, COMPANY, OPTIONS)
    const byId = Object.fromEntries(review.documents.map((d) => [d.id, d]))
    expect(review.documents).toHaveLength(2)
    expect(byId[first.id]).toMatchObject({ status: 'active', createdBy: CLAIMS.identityId, removedBy: null })
    expect(byId[second.id]).toMatchObject({ status: 'removed', removedBy: CLAIMS.identityId, removedAt: NOW })
  })
  it('denies the document review to a non reviewer and anonymous callers, and reports unknown companies', async () => {
    await expect(listD1CompanyDocumentsForReview(f.database, AGENT_CLAIMS, COMPANY, OPTIONS)).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(listD1CompanyDocumentsForReview(f.database, null, COMPANY, OPTIONS)).rejects.toMatchObject({
      code: 'unauthenticated'
    })
    reviewer()
    await expect(
      listD1CompanyDocumentsForReview(f.database, AGENT_CLAIMS, deterministicUuid('nope'), OPTIONS)
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(listD1CompanyDocumentsForReview(f.database, AGENT_CLAIMS, 'bad', OPTIONS)).rejects.toMatchObject({
      code: 'invalid_input'
    })
  })
})
