import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from './d1-sqlite'

export const CATEGORY_IDENTITY = '10000000-0000-4000-8000-000000000040'
export const CATEGORY_SESSION = '20000000-0000-4000-8000-000000000040'
export const ROOT_CATEGORY = '30000000-0000-4000-8000-000000000040'
export const CHILD_CATEGORY = '40000000-0000-4000-8000-000000000040'
export const OTHER_CATEGORY = '50000000-0000-4000-8000-000000000040'
export const CATEGORY_CLAIMS = { identityId: CATEGORY_IDENTITY, sessionId: CATEGORY_SESSION, sessionVersion: 1 }
export const categoryUtc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
/** Explicit local synthetic references. Never alter the shared migration/seed
 * adapter or manufacture production publication/financial approval evidence. */
export async function categoryCommandFixture() {
  const sqlite = await openMigratedDatabase()
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_category_commands'").get())
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0040_catalog_category_commands.sql', import.meta.url), 'utf8')
    )
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  const past = categoryUtc(-86400000)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'categories@example.invalid','synthetic-only',?,'active',?,?)"
    )
    .run(CATEGORY_IDENTITY, past, past, past)
  sqlite.exec(
    "INSERT INTO roles VALUES ('category_admin','Category admin','Synthetic fixture'); INSERT INTO permissions VALUES ('administration.manage','administration','manage','Manage categories'); INSERT INTO permissions VALUES ('catalog.write','catalog','write','Read private categories'); INSERT INTO role_permissions VALUES ('category_admin','administration.manage'); INSERT INTO role_permissions VALUES ('category_admin','catalog.write');"
  )
  sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'category_admin',?)")
    .run(CATEGORY_IDENTITY, past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
    )
    .run(CATEGORY_SESSION, CATEGORY_IDENTITY, past, categoryUtc(3600000))
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES (?,10,'Familia principal','familia-principal','published',10)"
    )
    .run(ROOT_CATEGORY)
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,sort_order) VALUES (?,11,?,'Familia hija','familia-hija','published',11)"
    )
    .run(CHILD_CATEGORY, ROOT_CATEGORY)
  sqlite
    .prepare(
      "INSERT INTO categories(id,legacy_id,name,slug,status,sort_order) VALUES (?,12,'Otra familia','otra-familia','draft',12)"
    )
    .run(OTHER_CATEGORY)
  return { sqlite, database: d1OverSqlite(sqlite) }
}
