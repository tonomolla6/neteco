import postgres from 'postgres'

const environment = process.env.APP_ENV ?? 'local'
const connection = process.env.DATABASE_URL?.trim()

if (!connection) throw new Error('DATABASE_URL is required')
if (!['local', 'test', 'demo'].includes(environment)) throw new Error(`Database reset is forbidden in ${environment}`)
if (process.env.ALLOW_DB_RESET !== 'true') throw new Error('Set ALLOW_DB_RESET=true to confirm the local/demo reset')

const sql = postgres(connection, { max: 1, connect_timeout: 10 })
try {
  await sql`DROP SCHEMA public CASCADE`
  await sql`CREATE SCHEMA public`
} finally {
  await sql.end({ timeout: 5 })
}

await import('./db-migrate')
await import('./db-seed')
