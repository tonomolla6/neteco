import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import postgres from 'postgres'
import { createIntegrationTemplate, dropIntegrationTemplate } from '../fixtures/postgres'

const execFileAsync = promisify(execFile)
const foundationMigration = '0001_platform_foundation.sql'

async function bootstrapFoundation(connection: string) {
  const source = await readFile(new URL(`../../db/migrations/${foundationMigration}`, import.meta.url), 'utf8')
  const checksum = createHash('sha256').update(source).digest('hex')
  const sql = postgres(connection, { max: 1, connect_timeout: 10 })
  try {
    await sql.begin(async (transaction) => {
      await transaction.unsafe(source)
      await transaction`
        CREATE TABLE _neteco_migrations (
          version text PRIMARY KEY,
          checksum_sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `
      await transaction`
        INSERT INTO _neteco_migrations (version, checksum_sha256) VALUES (${foundationMigration}, ${checksum})
      `
      await transaction`
        INSERT INTO roles (code, name, description) VALUES
          ('customer', 'Cliente', 'Acceso a recursos propios'),
          ('support', 'Soporte', 'Atención a clientes e incidencias'),
          ('warehouse', 'Almacén', 'Inventario y fulfillment'),
          ('catalog_editor', 'Editor de catálogo', 'Catálogo y contenido en borrador'),
          ('publisher', 'Publicador', 'Aprobación y publicación'),
          ('finance', 'Finanzas', 'Pagos, reembolsos y facturación'),
          ('admin', 'Administrador', 'Administración sin acceso implícito a secretos')
      `
    })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export default async function integrationGlobalSetup() {
  process.env.APP_ENV = 'test'
  process.env.NETECO_TEST_RUN_ID = `p${process.pid.toString(36)}`
  const connection = await createIntegrationTemplate()
  const environment = { ...process.env, APP_ENV: 'test', DATABASE_URL: connection }
  try {
    await bootstrapFoundation(connection)
    await execFileAsync('node_modules/.bin/tsx', ['scripts/db-migrate.ts'], { cwd: process.cwd(), env: environment })
    await execFileAsync('node_modules/.bin/tsx', ['scripts/db-seed.ts'], { cwd: process.cwd(), env: environment })
  } catch (error) {
    await dropIntegrationTemplate()
    throw error
  }
  return async () => {
    await dropIntegrationTemplate()
  }
}
