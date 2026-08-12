import Redis from 'ioredis'

let redis: Redis | undefined

export function redisUrl(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.REDIS_URL?.trim()
  if (!value && environment.APP_ENV === 'production') throw new Error('REDIS_URL is required')
  return value || 'redis://localhost:56379/0'
}

export function useRedis() {
  if (!redis) {
    redis = new Redis(redisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 3_000,
      commandTimeout: 3_000
    })
    redis.on('error', () => undefined)
  }
  return redis
}

export async function closeRedis() {
  if (!redis) return
  await redis.quit().catch(() => redis?.disconnect())
  redis = undefined
}
