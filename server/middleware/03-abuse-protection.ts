import { enforceRateLimit } from '../utils/rate-limit'
import { abuseLimitRule } from '../utils/abuse-limit'

export default defineEventHandler(async (event) => {
  const selected = abuseLimitRule(event.method.toUpperCase(), getRequestURL(event).pathname)
  if (!selected) return
  const subject =
    getCookie(event, 'neteco-session') ?? getCookie(event, 'neteco-cart') ?? getHeader(event, 'user-agent') ?? ''
  await enforceRateLimit(event, { ...selected, subject })
})
