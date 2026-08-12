import postgres, { type Sql } from 'postgres'

let database: Sql | undefined

export function databaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const value = env.DATABASE_URL?.trim()
  if (!value && env.APP_ENV === 'production') throw new Error('DATABASE_URL is required')
  if (!value) return 'postgres://neteco:neteco-local@localhost:56432/neteco'
  return value
}

export function useDatabase() {
  if (!database) {
    database = postgres(databaseUrl(), {
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idle_timeout: 20,
      connect_timeout: 10,
      max_lifetime: 60 * 30,
      prepare: true,
      transform: { undefined: null }
    })
  }
  return database
}

export async function closeDatabase() {
  if (!database) return
  await database.end({ timeout: 5 })
  database = undefined
}
