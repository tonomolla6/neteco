import { useDatabase } from '../../../db/client'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const account = await requireCustomerAccount(event)
  const sql = useDatabase()
  const sessions = await sql`
    SELECT id, mfa_verified AS "mfaVerified", created_at AS "createdAt",
           last_seen_at AS "lastSeenAt", expires_at AS "expiresAt",
           id = ${account.session.sessionId!} AS current
    FROM auth_sessions
    WHERE identity_id = ${account.profile.id} AND revoked_at IS NULL AND expires_at > now()
    ORDER BY last_seen_at DESC
  `
  setResponseHeader(event, 'cache-control', 'private, no-store')
  return { sessions }
})
