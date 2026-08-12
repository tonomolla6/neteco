import type { H3Event } from 'h3'
import { requirePermission } from './auth-session'

export async function requireAdmin(event: H3Event) {
  const authenticated = await requirePermission(event, 'administration.manage', { mfa: true })
  return authenticated.profile
}
