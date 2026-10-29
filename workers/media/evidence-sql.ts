function conjunction(clauses: readonly string[]): string {
  if (clauses.length === 1) return `(${clauses[0]})`
  if (!clauses.length) throw new Error('empty_media_evidence_conjunction')
  const middle = Math.floor(clauses.length / 2)
  return `(${conjunction(clauses.slice(0, middle))} AND ${conjunction(clauses.slice(middle))})`
}

/** Private, current D1 attestation predicate. It never makes a product public
 * and never asserts that R2 bytes exist. Bind the canonical internal clock.
 */
export function eligibleMediaEvidenceSql() {
  // Keep every attestation check, but avoid a left-deep AND tree in D1.
  const requirements = [
    `upload.storage_status = 'quarantined'`,
    `upload.stored_at IS NOT NULL`,
    `upload.stored_at<=supplied_now.now`,
    `upload.r2_etag IS NOT NULL`,
    `length(upload.r2_etag)>0`,
    `length(upload.checksum)=64`,
    `upload.checksum NOT GLOB '*[^0-9a-f]*'`,
    `upload.object_key='quarantine/'||upload.id||'/'||upload.checksum`,
    `upload.byte_size BETWEEN 1 AND 10485760`,
    `scan.verdict = 'clean'`,
    `scan.scanned_at <= supplied_now.now`,
    `scan.expires_at > supplied_now.now`,
    `scan.checksum = upload.checksum`,
    `scan.object_key = upload.object_key`,
    `scan.byte_size = upload.byte_size`,
    `scan.seq = (SELECT MAX(seq) FROM media_scan_receipts WHERE upload_id = upload.id)`,
    `rights.decision = 'approved'`,
    `rights.created_at <= supplied_now.now`,
    `rights.seq = (SELECT MAX(seq) FROM media_rights_decisions WHERE upload_id = upload.id)`,
    `publication.valid_from <= supplied_now.now`,
    `(publication.valid_until IS NULL OR publication.valid_until > supplied_now.now)`,
    `publication.created_at <= supplied_now.now`,
    `NOT EXISTS (SELECT 1 FROM product_media_publication_events event WHERE event.publication_id = publication.id)`,
    `(publication.variant_id IS NULL OR variant.id IS NOT NULL)`,
    `((publication.role IN ('main', 'image', 'label') AND upload.content_type IN ('image/png', 'image/jpeg'))
      OR (publication.role IN ('datasheet', 'sds', 'certificate', 'label') AND upload.content_type = 'application/pdf'))`
  ]
  return `WITH supplied_now AS (SELECT ? AS now)
    SELECT publication.id, publication.product_id, publication.variant_id, publication.upload_id,
      publication.role, publication.title, publication.alt, publication.language, publication.version,
      publication.valid_from, publication.valid_until, publication.created_at, publication.rights_decision_id, publication.scan_receipt_id,
      rights.evidence_authorized_at AS authorized_at, upload.object_key, upload.checksum,
      upload.byte_size, upload.r2_etag, upload.content_type, upload.filename, upload.width, upload.height
    FROM product_media_publications publication
    JOIN media_uploads upload ON upload.id = publication.upload_id
    JOIN media_scan_receipts scan ON scan.id = publication.scan_receipt_id AND scan.upload_id = upload.id
    JOIN media_rights_decisions rights ON rights.id = publication.rights_decision_id AND rights.upload_id = upload.id
    JOIN products product ON product.id = publication.product_id
    JOIN categories category ON category.id = product.category_id
    LEFT JOIN variants variant ON variant.id = publication.variant_id AND variant.product_id = product.id
    CROSS JOIN supplied_now
    WHERE ${conjunction(requirements)}`
}
