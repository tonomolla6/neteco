import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const database = new URL(connection)
if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL')

const destination = resolve(process.env.BACKUP_DIRECTORY?.trim() || 'backups')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dumpPath = resolve(destination, `neteco-${stamp}.dump`)
const manifestPath = `${dumpPath}.json`

await mkdir(destination, { recursive: true, mode: 0o700 })

const pgDumpArguments = ['--format=custom', '--compress=9', '--no-owner', '--no-privileges']
const composeService = process.env.PG_DUMP_COMPOSE_SERVICE?.trim()
const executable = composeService ? 'docker' : process.env.PG_DUMP_BINARY?.trim() || 'pg_dump'
const arguments_ = composeService
  ? [
      'compose',
      'exec',
      '-T',
      composeService,
      'pg_dump',
      '--username',
      decodeURIComponent(database.username),
      '--dbname',
      decodeURIComponent(database.pathname.slice(1)),
      ...pgDumpArguments
    ]
  : pgDumpArguments
const dump = spawn(executable, arguments_, {
  env: {
    ...process.env,
    PGHOST: database.hostname,
    PGPORT: database.port || '5432',
    PGDATABASE: decodeURIComponent(database.pathname.slice(1)),
    PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password),
    ...(database.searchParams.get('sslmode') ? { PGSSLMODE: database.searchParams.get('sslmode')! } : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let diagnostic = ''
dump.stderr.setEncoding('utf8')
dump.stderr.on('data', (chunk: string) => {
  diagnostic = `${diagnostic}${chunk}`.slice(-4_000)
})
const exit = new Promise<number | null>((done, reject) => {
  dump.once('error', reject)
  dump.once('close', done)
})

try {
  await pipeline(dump.stdout, createWriteStream(dumpPath, { mode: 0o600 }))
  const exitCode = await exit
  if (exitCode !== 0) throw new Error(`pg_dump failed (${exitCode}): ${diagnostic.trim()}`)

  const bytes = await readFile(dumpPath)
  const manifest = {
    format: 'postgresql-custom',
    createdAt: new Date().toISOString(),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    restoreCommand: 'pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" <dump-file>'
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write(
    `${JSON.stringify({ event: 'database.backup.completed', dumpPath, manifestPath, ...manifest })}\n`
  )
} catch (error) {
  await unlink(dumpPath).catch(() => undefined)
  throw error
}
