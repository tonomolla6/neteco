import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const connection = process.env.DATABASE_URL?.trim()
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
if (!connection) throw new Error('DATABASE_URL is required')
if (!email) throw new Error('ADMIN_EMAIL is required')

const sql = postgres(connection, { max: 1, connect_timeout: 10 })
const correlationId = randomUUID()

try {
  const result = await sql.begin(async (transaction) => {
    const [identity] = await transaction<{ id: string; verified: boolean; status: string }[]>`
      SELECT id, email_verified_at IS NOT NULL AS verified, status
      FROM identities WHERE email = ${email} FOR UPDATE
    `
    if (!identity) throw new Error('The administrator must register an account first')
    if (!identity.verified) throw new Error('The administrator email must be verified first')
    if (!['pending', 'active'].includes(identity.status)) throw new Error('The identity is not active')
    await transaction`
      UPDATE identities SET status = 'active', session_version = session_version + 1, updated_at = now()
      WHERE id = ${identity.id}
    `
    await transaction`
      INSERT INTO identity_roles (identity_id, role_code)
      VALUES (${identity.id}, 'admin')
      ON CONFLICT (identity_id, role_code) DO NOTHING
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, action, resource_type, resource_id, before_redacted, after_redacted, reason, correlation_id
      ) VALUES (
        'system', 'identity.admin.provisioned', 'identity', ${identity.id}, ${transaction.json({ role: 'customer' })},
        ${transaction.json({ role: 'admin', passwordCreated: false })},
        'Explicit one-shot ADMIN_EMAIL provisioning', ${correlationId}
      )
    `
    return { identityId: identity.id, role: 'admin', sessionsRevoked: true, mfaRequiredAtNextAdminAccess: true }
  })
  process.stdout.write(`${JSON.stringify({ event: 'identity.admin.provisioned', correlationId, ...result })}\n`)
} finally {
  await sql.end({ timeout: 5 })
}
