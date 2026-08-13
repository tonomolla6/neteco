import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

const migrationsDirectory = resolve('db/migrations')
const connection = process.env.DATABASE_URL?.trim()

if (!connection) throw new Error('DATABASE_URL is required')

const sql = postgres(connection, { max: 1, connect_timeout: 10, onnotice: () => undefined })

try {
  await sql`
    CREATE TABLE IF NOT EXISTS _neteco_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file)).sort()

  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:migrations'))`
    const applied = await transaction<{ version: string; checksum_sha256: string }[]>`
      SELECT version, checksum_sha256 FROM _neteco_migrations ORDER BY version
    `
    const byVersion = new Map(applied.map((migration) => [migration.version, migration.checksum_sha256]))

    for (const file of files) {
      const source = await readFile(resolve(migrationsDirectory, file), 'utf8')
      const checksum = createHash('sha256').update(source).digest('hex')
      const previousChecksum = byVersion.get(file)

      if (previousChecksum && previousChecksum !== checksum) {
        throw new Error(`Applied migration ${file} was modified`)
      }
      if (previousChecksum) continue

      if (file === '0002_identity_security.sql') {
        await transaction`
          INSERT INTO roles (code, name, description) VALUES
            ('customer', 'Cliente', 'Acceso a recursos propios'),
            ('support', 'Soporte', 'Atención a clientes e incidencias'),
            ('warehouse', 'Almacén', 'Inventario y fulfillment'),
            ('catalog_editor', 'Editor de catálogo', 'Catálogo y contenido en borrador'),
            ('publisher', 'Publicador', 'Aprobación y publicación'),
            ('finance', 'Finanzas', 'Pagos, reembolsos y facturación'),
            ('admin', 'Administrador', 'Administración sin acceso implícito a secretos')
          ON CONFLICT (code) DO NOTHING
        `
      }
      await transaction.unsafe(source)
      await transaction`
        INSERT INTO _neteco_migrations (version, checksum_sha256)
        VALUES (${file}, ${checksum})
      `
      process.stdout.write(`applied ${file}\n`)
    }
  })
} finally {
  await sql.end({ timeout: 5 })
}
