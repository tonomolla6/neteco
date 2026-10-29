/** Synthetic, isolated audit-fixture enrollment only. Never a login or grant. */
export async function prepareNativeAuditAdminMfa(database: D1Database, identityId: string, now: string): Promise<void> {
  const result = await database
    .prepare(
      `INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at)
     VALUES(?1,'synthetic-audit-not-production','[]',?2,?2)
     ON CONFLICT(identity_id) DO NOTHING`
    )
    .bind(identityId, now)
    .run()
  if (!result.success) throw new Error('synthetic_audit_mfa_preparation_failed')
}
