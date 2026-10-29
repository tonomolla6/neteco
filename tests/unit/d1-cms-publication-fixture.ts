import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { cmsFixture, cmsDocument, CMS_CLAIMS, CMS_IDENTITY, cmsUtc } from './d1-cms-fixture'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import type { CmsPublicationDependencies } from '../../workers/cms/publication-gate'
export async function cmsPublicationFixture() {
  const fixture = await cmsFixture()
  if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='content_publication_states'").get())
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0045_cms_publication.sql', import.meta.url), 'utf8')
    )
  const deps: CmsPublicationDependencies = {
    database: fixture.database,
    enabled: true,
    preview: { origin: 'https://cms.neteco.invalid', secret: randomBytes(48).toString('base64url') }
  }
  const created = await executeD1CmsDraftCommand(
    fixture.database,
    CMS_CLAIMS,
    'create_draft',
    {},
    { ...cmsDocument(), expectedVersion: 0 },
    { idempotencyKey: crypto.randomUUID() }
  )
  return { ...fixture, deps, created }
}
export async function cmsImageFixture(fixture: Awaited<ReturnType<typeof cmsPublicationFixture>>) {
  const id = crypto.randomUUID(),
    scan = crypto.randomUUID(),
    rights = crypto.randomUUID(),
    bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(100).fill(0)])
  const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(''),
    now = cmsUtc(-60000),
    key = `quarantine/${id}/${checksum}`
  fixture.sqlite
    .prepare(
      `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,byte_size,width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at) VALUES (?,?,?,?,?,?,'cms.png','image/png',?,800,800,'CMS image','Synthetic owner','Synthetic license','Synthetic fixture only','quarantined','cms-etag',?,?)`
    )
    .run(id, CMS_IDENTITY, crypto.randomUUID(), checksum, checksum, key, bytes.length, now, now)
  fixture.sqlite
    .prepare(
      `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash) VALUES (?,?,?,?,?,'clean','synthetic-fixture',?,?,?,?)`
    )
    .run(scan, id, checksum, key, bytes.length, now, cmsUtc(3600000), now, checksum)
  fixture.sqlite
    .prepare(
      `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,evidence_reference,rights_owner,rights_license,created_at,idempotency_key,payload_hash) VALUES (?,?,'approved','Synthetic only',?,'2026-01-01','Synthetic evidence','Synthetic owner','Synthetic license',?,?,?)`
    )
    .run(rights, id, CMS_IDENTITY, now, crypto.randomUUID(), checksum)
  const updated = await executeD1CmsDraftCommand(
    fixture.database,
    CMS_CLAIMS,
    'update_draft',
    { pageId: fixture.created.pageId },
    {
      ...cmsDocument({
        blocks: [{ id: crypto.randomUUID(), type: 'image', assetId: id, alt: 'Synthetic CMS image', caption: '' }]
      }),
      expectedVersion: 1
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  const bucket: Pick<R2Bucket, 'get'> = {
    get: async () => ({ etag: 'cms-etag', size: bytes.length, body: new Blob([bytes]).stream() }) as R2ObjectBody
  }
  const images: Pick<ImagesBinding, 'input'> = {
    input: () => ({
      transform() {
        return this
      },
      draw() {
        throw new Error('Synthetic CMS image fixture does not implement drawing')
      },
      output: async () => ({
        response: () => new Response(bytes, { headers: { 'content-type': 'image/webp' } }),
        contentType: () => 'image/webp',
        image: () => new Blob([bytes]).stream()
      })
    })
  }
  return { ...fixture, updated, id, scan, rights, bytes, key, deps: { ...fixture.deps, bucket, images } }
}
