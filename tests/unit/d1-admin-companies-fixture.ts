import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import { readFile } from 'node:fs/promises'
export const NOW = '2030-01-02T12:00:00Z'
export const BEFORE = '2020-01-01T00:00:00Z'
export const ACTOR = deterministicUuid('company-admin'),
  SESSION = deterministicUuid('company-admin-session'),
  CUSTOMER = deterministicUuid('company-customer'),
  OWNER = deterministicUuid('company-owner'),
  COMPANY = deterministicUuid('company')
export const CLAIMS = { identityId: ACTOR, sessionId: SESSION, sessionVersion: 1 }
export const KEY = deterministicUuid('company-review-key')
export const OPTIONS = { now: () => NOW }
export const INPUT = {
  expectedChangeId: null,
  expectedStatus: 'pending' as const,
  status: 'approved' as const,
  reason: 'Comprobación administrativa documentada'
}
export function seedStatements() {
  return [
    `INSERT INTO customers(id,name,created_at,updated_at) VALUES('${CUSTOMER}','Cliente sintético','${BEFORE}','${BEFORE}')`,
    `INSERT INTO identities(id,email,password_hash,status,email_verified_at,created_at,updated_at) VALUES('${ACTOR}','admin@example.invalid','synthetic','active','${BEFORE}','${BEFORE}','${BEFORE}')`,
    `INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES('${OWNER}','owner@example.invalid','synthetic','active','${BEFORE}','${CUSTOMER}','${BEFORE}','${BEFORE}')`,
    `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('${SESSION}','${ACTOR}',1,1,'${BEFORE}','2099-01-01T00:00:00Z')`,
    `INSERT INTO roles VALUES('company-admin','Company admin','Synthetic')`,
    `INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic')`,
    `INSERT INTO role_permissions VALUES('company-admin','administration.manage')`,
    `INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${ACTOR}','company-admin','${BEFORE}')`,
    `INSERT INTO companies(id,customer_id,legal_name,tax_id,country_code,status,created_at,updated_at) VALUES('${COMPANY}','${CUSTOMER}','Ácido %_\\ industrial','B12345674','ES','pending','${BEFORE}','${BEFORE}')`
  ]
}
export async function companyFixture() {
  const sqlite = await openMigratedDatabase()
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='company_admin_review_commands'").get())
    sqlite.exec(await readFile('db/d1/migrations/0064_company_admin_review.sql', 'utf8'))
  for (const sql of seedStatements()) sqlite.exec(sql)
  return { sqlite, database: d1OverSqlite(sqlite) }
}
