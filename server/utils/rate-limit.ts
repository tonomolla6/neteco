import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { getRequestIP, setResponseHeader } from 'h3'
import { useRedis } from '../db/redis'

const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`

export function privacyHash(value: string) {
  return createHash('sha256').update(`neteco-rate-v1:${value}`, 'utf8').digest('hex')
}

export async function enforceRateLimit(
  event: H3Event,
  input: { scope: string; subject?: string; limit: number; windowSeconds: number }
) {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const identity = privacyHash(`${ip}:${input.subject?.trim().toLowerCase() ?? ''}`)
  const key = `neteco:rate:${input.scope}:${identity}`
  let result: [number, number]
  try {
    const redis = useRedis()
    if (redis.status === 'wait') await redis.connect()
    result = (await redis.eval(FIXED_WINDOW_SCRIPT, 1, key, String(input.windowSeconds * 1000))) as [number, number]
  } catch {
    if (process.env.APP_ENV === 'production') {
      throw createError({ statusCode: 503, statusMessage: 'Authentication protection is unavailable' })
    }
    return
  }
  const remaining = Math.max(input.limit - result[0], 0)
  setResponseHeader(event, 'x-ratelimit-limit', String(input.limit))
  setResponseHeader(event, 'x-ratelimit-remaining', String(remaining))
  if (result[0] > input.limit) {
    const retryAfter = Math.max(Math.ceil(result[1] / 1000), 1)
    setResponseHeader(event, 'retry-after', retryAfter)
    throw createError({ statusCode: 429, statusMessage: 'Demasiados intentos. Inténtalo más tarde.' })
  }
}
