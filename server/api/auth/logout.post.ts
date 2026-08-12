import { revokeCurrentSession } from '../../utils/auth-session'

export default defineEventHandler(async (event) => {
  await revokeCurrentSession(event)
  return { ok: true }
})
