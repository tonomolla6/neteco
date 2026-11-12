import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { afterEach, vi } from 'vitest'
const CMS_NOW = '2026-01-15T09:00:00Z'
let ownsClock = false
afterEach(() => {
  if (ownsClock) vi.useRealTimers()
  ownsClock = false
})
export const CMS_IDENTITY = '10000000-0000-4000-8000-000000000044'
export const CMS_SESSION = '20000000-0000-4000-8000-000000000044'
export const CMS_BLOCK = '30000000-0000-4000-8000-000000000044'
export const CMS_CLAIMS = { identityId: CMS_IDENTITY, sessionId: CMS_SESSION, sessionVersion: 1 }
export const cmsUtc = (offset = 0) => new Date(Date.parse(CMS_NOW) + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
export function cmsDocument(extra: Record<string, unknown> = {}) {
  return {
    title: 'Guía editorial',
    slug: 'guia-editorial',
    blocks: [{ id: CMS_BLOCK, type: 'paragraph', text: 'Contenido sintético privado.' }],
    seo: { title: 'Guía editorial', description: 'Guía editorial sintética para pruebas locales.', noindex: true },
    changeSummary: 'Versión inicial sintética',
    ...extra
  }
}
export async function cmsFixture() {
  // Both JS authorization and SQL transaction guards must see the same fixed
  // clock. Importing cmsDocument alone (compiled/native suites) changes no clock.
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ['Date'] })
    ownsClock = true
  }
  vi.setSystemTime(CMS_NOW)
  const sqlite = await openMigratedDatabase()
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='content_draft_commands'").get())
    sqlite.exec(await readFile(new URL('../../db/d1/migrations/0044_cms_draft_commands.sql', import.meta.url), 'utf8'))
  sqlite.limits.exprDepth = 100
  sqlite.limits.variableNumber = 100
  sqlite.limits.functionArg = 32
  const past = cmsUtc(-86400000)
  sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'cms@example.invalid','synthetic-only',?,'active',?,?)"
    )
    .run(CMS_IDENTITY, past, past, past)
  sqlite.exec(`INSERT INTO roles VALUES ('cms_editor','CMS editor','Synthetic fixture');
    INSERT OR IGNORE INTO permissions VALUES ('catalog.write','catalog','write','CMS authoring'),('catalog.publish','catalog','publish','CMS restoration'),('administration.manage','administration','manage','CMS archival');
    INSERT INTO role_permissions VALUES ('cms_editor','catalog.write'),('cms_editor','catalog.publish'),('cms_editor','administration.manage');`)
  sqlite
    .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'cms_editor',?)")
    .run(CMS_IDENTITY, past)
  sqlite
    .prepare(
      'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
    )
    .run(CMS_SESSION, CMS_IDENTITY, past, cmsUtc(3600000))
  sqlite.function('cms_fixture_now', { deterministic: true }, () => CMS_NOW)
  const adapter = d1OverSqlite(sqlite)
  const database = {
    ...adapter,
    prepare(sql: string) {
      return adapter.prepare(sql.replace(/strftime\('%Y-%m-%dT%H:%M:%SZ',\s*'now'\)/g, 'cms_fixture_now()'))
    }
  } as D1Database
  return { sqlite, database }
}
