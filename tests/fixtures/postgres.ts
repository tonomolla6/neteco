import { createHash } from 'node:crypto'
import postgres, { type Sql } from 'postgres'

function testRunId() {
  const value = process.env.NETECO_TEST_RUN_ID?.trim()
  if (!value || !/^[a-z0-9_]+$/.test(value)) throw new Error('NETECO_TEST_RUN_ID is required for database isolation')
  return value
}

function integrationTemplateDatabase() {
  const workspace = createHash('sha256').update(process.cwd(), 'utf8').digest('hex').slice(0, 8)
  return `neteco_it_template_${workspace}_${testRunId()}`
}

function testClusterUrl() {
  if (process.env.APP_ENV !== 'test') throw new Error('Isolated test databases require APP_ENV=test')
  const value = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
  const url = new URL(value)
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new Error('Isolated test databases are restricted to a local PostgreSQL host')
  }
  const sourceDatabase = url.pathname.slice(1)
  if (!['neteco', 'neteco_test'].includes(sourceDatabase) && !sourceDatabase.startsWith('neteco_it_')) {
    throw new Error('DATABASE_URL must target an approved NETECO test database')
  }
  return url
}

function databaseUrl(database: string) {
  const url = testClusterUrl()
  url.pathname = `/${database}`
  return url.toString()
}

function databaseName(namespace: string) {
  const digest = createHash('sha256').update(`${testRunId()}:${namespace}`, 'utf8').digest('hex').slice(0, 20)
  return `neteco_it_${testRunId()}_${digest}`
}

async function dropDatabase(admin: Sql, name: string) {
  if (!/^neteco_it_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to drop unsafe database name: ${name}`)
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`)
}

export async function createIntegrationTemplate() {
  const template = integrationTemplateDatabase()
  const admin = postgres(databaseUrl('postgres'), { max: 1, connect_timeout: 10, onnotice: () => undefined })
  try {
    await dropDatabase(admin, template)
    await admin.unsafe(`CREATE DATABASE "${template}" TEMPLATE template0`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  return databaseUrl(template)
}

export async function dropIntegrationTemplate() {
  const template = integrationTemplateDatabase()
  const admin = postgres(databaseUrl('postgres'), { max: 1, connect_timeout: 10, onnotice: () => undefined })
  try {
    await dropDatabase(admin, template)
  } finally {
    await admin.end({ timeout: 5 })
  }
}

export interface IsolatedPostgresDatabase {
  connection: string
  sql: Sql
  dispose(): Promise<void>
}

export async function isolatedPostgresDatabase(namespace: string): Promise<IsolatedPostgresDatabase> {
  const name = databaseName(namespace)
  const template = integrationTemplateDatabase()
  const admin = postgres(databaseUrl('postgres'), { max: 1, connect_timeout: 10, onnotice: () => undefined })
  try {
    await dropDatabase(admin, name)
    await admin.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const connection = databaseUrl(name)
  const sql = postgres(connection, { max: 4, connect_timeout: 10 })
  return {
    connection,
    sql,
    async dispose() {
      try {
        await sql.end({ timeout: 5 })
      } finally {
        const cleanup = postgres(databaseUrl('postgres'), { max: 1, connect_timeout: 10, onnotice: () => undefined })
        try {
          await dropDatabase(cleanup, name)
        } finally {
          await cleanup.end({ timeout: 5 })
        }
      }
    }
  }
}
