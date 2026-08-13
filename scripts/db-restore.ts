import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

const connection = process.env.DATABASE_URL?.trim()
const dumpArgument = process.argv[2]?.trim()
const targetEnvironment = process.env.RESTORE_TARGET_ENV?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
if (!dumpArgument) throw new Error('Usage: npm run db:restore -- <absolute-or-relative.dump>')
if (!['test', 'staging', 'restore-drill'].includes(targetEnvironment ?? '')) {
  throw new Error(
    'RESTORE_TARGET_ENV must be test, staging or restore-drill; production restores use the provider runbook'
  )
}

const database = new URL(connection)
if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL')
const databaseName = decodeURIComponent(database.pathname.slice(1))
const expectedConfirmation = `restore:${database.hostname}:${databaseName}`
if (!/^neteco_(restore|drill|test|staging)[a-z0-9_]*$/.test(databaseName)) {
  throw new Error(
    'Restore target database name must start with neteco_restore, neteco_drill, neteco_test or neteco_staging'
  )
}
if (process.env.RESTORE_CONFIRM !== expectedConfirmation) {
  throw new Error(`Set RESTORE_CONFIRM=${expectedConfirmation} after verifying the isolated target`)
}

const dumpPath = resolve(dumpArgument)
const manifestPath = `${dumpPath}.json`
const [dump, manifestSource] = await Promise.all([readFile(dumpPath), readFile(manifestPath, 'utf8')])
const manifest = JSON.parse(manifestSource) as { format?: string; bytes?: number; sha256?: string }
const actualHash = createHash('sha256').update(dump).digest('hex')
if (manifest.format !== 'postgresql-custom' || manifest.bytes !== dump.byteLength || manifest.sha256 !== actualHash) {
  throw new Error('Backup manifest, size or SHA-256 verification failed')
}

const restore = spawn(
  process.env.PG_RESTORE_BINARY?.trim() || 'pg_restore',
  ['--clean', '--if-exists', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', databaseName, dumpPath],
  {
    env: {
      ...process.env,
      PGHOST: database.hostname,
      PGPORT: database.port || '5432',
      PGDATABASE: databaseName,
      PGUSER: decodeURIComponent(database.username),
      PGPASSWORD: decodeURIComponent(database.password),
      ...(database.searchParams.get('sslmode') ? { PGSSLMODE: database.searchParams.get('sslmode')! } : {})
    },
    stdio: ['ignore', 'ignore', 'pipe']
  }
)
let diagnostic = ''
restore.stderr.setEncoding('utf8')
restore.stderr.on('data', (chunk: string) => {
  diagnostic = `${diagnostic}${chunk}`.slice(-4_000)
})
const exitCode = await new Promise<number | null>((done, reject) => {
  restore.once('error', reject)
  restore.once('close', done)
})
if (exitCode !== 0) throw new Error(`pg_restore failed (${exitCode}): ${diagnostic.trim()}`)

const sql = postgres(connection, { max: 1, connect_timeout: 10 })
try {
  const [verification] = await sql<
    Array<{ migrations: number; products: number; variants: number; orders: number; integrityFailures: number }>
  >`
    SELECT
      (SELECT count(*)::int FROM _neteco_migrations) AS migrations,
      (SELECT count(*)::int FROM products) AS products,
      (SELECT count(*)::int FROM variants) AS variants,
      (SELECT count(*)::int FROM orders) AS orders,
      (SELECT count(*)::int FROM inventory_balances balance
       WHERE balance.physical_quantity < 0 OR balance.blocked_quantity > balance.physical_quantity) AS "integrityFailures"
  `
  if (!verification || verification.migrations < 1 || verification.integrityFailures > 0) {
    throw new Error('Restored database failed integrity verification')
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'database.restore.verified',
      targetEnvironment,
      targetHost: database.hostname,
      targetDatabase: databaseName,
      backupSha256: actualHash,
      ...verification
    })}\n`
  )
} finally {
  await sql.end({ timeout: 5 })
}
