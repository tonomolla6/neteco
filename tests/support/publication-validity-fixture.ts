import type { REQUIRED_PUBLICATION_FIELDS, PUBLICATION_DOCUMENT_ROLES } from '../../shared/catalog-publication-policy'
import { testUuid, testNow } from './deterministic'

const ACTOR = '70000000-0000-4000-8000-000000000038'
const checksum = 'f'.repeat(64)
const utc = () => new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')

/** Explicitly selected SYNTHETIC test products only. These D1 rows are not real
 * legal/antivirus approvals, stored R2 originals or production migration/seed.
 * Tests that own byte/media fixtures use media:false and keep those negatives.
 */
export async function provisionPublicationValidityFixture(
  database: D1Database,
  options: {
    productIds: readonly string[]
    now?: string
    validUntil?: string | null
    requiredFields?: (typeof REQUIRED_PUBLICATION_FIELDS)[number][]
    requiredMediaRoles?: (typeof PUBLICATION_DOCUMENT_ROLES)[number][]
    identifierExceptionsAllowed?: boolean
    media?: boolean
  }
) {
  const now = options.now ?? utc(),
    validUntil = options.validUntil === undefined ? null : options.validUntil
  const policyId = testUuid()
  await database
    .prepare(
      `INSERT OR IGNORE INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
    VALUES (?,'validity-fixture@example.invalid','synthetic-not-login',?,'active',?,?)`
    )
    .bind(ACTOR, now, now, now)
    .run()
  await database
    .prepare(
      `INSERT INTO catalog_publication_policies(id,code,version,name,required_fields,required_media_roles,
    identifier_exceptions_allowed,actor_id,reason,valid_from,valid_until,created_at)
    SELECT ?,'local_fixture',COALESCE(MAX(version),0)+1,'Synthetic local validity policy',?,?,?,?,'Synthetic test only, not legal acceptance',?,?,?
    FROM catalog_publication_policies WHERE code='local_fixture'`
    )
    .bind(
      policyId,
      JSON.stringify(options.requiredFields ?? []),
      JSON.stringify(options.requiredMediaRoles ?? []),
      options.identifierExceptionsAllowed ? 1 : 0,
      ACTOR,
      now,
      validUntil,
      now
    )
    .run()
  const assignments = new Map<string, string>(),
    mainPublications = new Map<string, { id: string; uploadId: string; scanId: string; rightsId: string }>()
  for (const productId of [...new Set(options.productIds)]) {
    const product = await database
      .prepare('SELECT id,brand_id AS brandId FROM products WHERE id=?')
      .bind(productId)
      .first<{ id: string; brandId: string | null }>()
    if (!product) throw new Error('missing_synthetic_validity_product')
    const assignment = testUuid()
    await database
      .prepare(
        `INSERT INTO catalog_product_publication_policies(id,product_id,policy_id,actor_id,reason,created_at)
      VALUES (?,?,?,?,'Synthetic selected test assignment, not production approval',?)`
      )
      .bind(assignment, productId, policyId, ACTOR, now)
      .run()
    assignments.set(productId, assignment)
    await database
      .prepare(
        `UPDATE products SET regulatory=json_set(regulatory,'$.productType','local_fixture','$.requiresSds',json('false')),
      brand_id=COALESCE(brand_id,(SELECT id FROM brands WHERE status='published' ORDER BY id LIMIT 1)) WHERE id=? AND json_type(regulatory)='object'`
      )
      .bind(productId)
      .run()
    await database
      .prepare(
        `UPDATE variants SET mpn='SYNTHETIC-VALIDITY-'||id WHERE product_id=? AND status<>'discontinued'
      AND COALESCE(ean,'')='' AND COALESCE(gtin,'')='' AND length(trim(COALESCE(mpn,'')))=0`
      )
      .bind(productId)
      .run()
    if (options.media === false) continue
    const existing = await database
      .prepare(
        "SELECT id FROM product_media_publications WHERE product_id=? AND variant_id IS NULL AND role='main' LIMIT 1"
      )
      .bind(productId)
      .first<{ id: string }>()
    if (existing) continue
    const uploadId = testUuid(),
      scanId = testUuid(),
      rightsId = testUuid(),
      id = testUuid()
    const key = `quarantine/${uploadId}/${checksum}`
    await database.batch([
      database
        .prepare(
          `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,byte_size,width,height,alt,
        rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
        VALUES (?,?,?,?,?,?,'synthetic-validity.png','image/png',33,800,600,'Synthetic selected product image',
          'Synthetic owner','Synthetic test-only license','Synthetic reference','quarantined',?,?,?)`
        )
        .bind(uploadId, ACTOR, uploadId, checksum, checksum, key, checksum, now, now),
      database
        .prepare(
          `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash)
        VALUES (?,?,?,?,33,'clean','Synthetic-not-antivirus',?,?,?,?)`
        )
        .bind(scanId, uploadId, checksum, key, now, validUntil ?? '2099-01-01T00:00:00Z', now, checksum),
      database
        .prepare(
          `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,evidence_reference,
        rights_owner,rights_license,created_at,idempotency_key,payload_hash)
        VALUES (?,?,'approved','Synthetic reviewer only',?,?,'Synthetic test-only reference','Synthetic owner','Synthetic local-only license',?,?,?)`
        )
        .bind(rightsId, uploadId, ACTOR, now.slice(0, 10), now, rightsId, checksum),
      database
        .prepare(
          `INSERT INTO product_media_publications(id,product_id,upload_id,role,title,alt,language,version,valid_from,valid_until,scan_receipt_id,
        rights_decision_id,actor_id,created_at,idempotency_key,payload_hash)
        VALUES (?,?,?,'main','Synthetic product image','Synthetic selected product image','es','synthetic-v1',?,?,?,?,?,?,?,?)`
        )
        .bind(id, productId, uploadId, now, validUntil, scanId, rightsId, ACTOR, now, id, checksum)
    ])
    mainPublications.set(productId, { id, uploadId, scanId, rightsId })
  }
  return { policyId, assignments, mainPublications }
}
