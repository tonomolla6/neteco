import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openMigratedDatabase } from '../support/d1-sqlite'

const now = '2026-08-25T09:00:00Z'
async function fixture() {
  const db = await openMigratedDatabase()
  try {
    db.exec(await readFile('db/d1/migrations/0105_b2b_credit_terms.sql', 'utf8'))
    db.exec(`INSERT INTO customers(id,created_at,updated_at) VALUES('customer','${now}','${now}'),('other','${now}','${now}');
      INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES
      ('company','customer','Company','approved','${now}','${now}'),('pending','other','Pending','pending','${now}','${now}');
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES('admin','credit@example.invalid','synthetic','${now}','active','${now}','${now}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES('session','admin',1,1,'${now}','2026-08-27T09:00:00Z');
      INSERT INTO roles(code,name,description) VALUES('credit-admin','Admin','Synthetic');
      INSERT INTO permissions(code,resource,action,description) VALUES('administration.manage','administration','manage','Synthetic');
      INSERT INTO role_permissions(role_code,permission_code) VALUES('credit-admin','administration.manage');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('admin','credit-admin','${now}');`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

describe('B2B credit terms database contract', () => {
  const insert = `INSERT INTO b2b_credit_commands(actor_id,command_id,session_id,session_version,company_id,expected_version,payment_days,credit_limit_cents,blocked,block_reason,reason,payload_hash,created_at) VALUES('admin',?,'session',1,?,?,?,?,?,?,? ,?,?)`
  function command(
    db: Awaited<ReturnType<typeof fixture>>,
    id: string,
    company = 'company',
    version = 0,
    days = 30,
    limit = 100,
    blocked = 0,
    blockReason: string | null = null
  ) {
    db.prepare(insert).run(
      id,
      company,
      version,
      days,
      limit,
      blocked,
      blockReason,
      'Commercial agreement',
      'a'.repeat(64),
      now
    )
  }
  it.each([0, 15, 30, 60])('records approved terms at %i days and audits the command', async (days) => {
    const db = await fixture()
    try {
      command(db, 'one', 'company', 0, days)
      expect(db.prepare('SELECT payment_days,credit_limit_cents,version FROM b2b_credit_terms').get()).toMatchObject({
        payment_days: days,
        credit_limit_cents: 100,
        version: 1
      })
      expect(db.prepare('SELECT command_id FROM b2b_credit_commands').get()).toMatchObject({ command_id: 'one' })
    } finally {
      db.close()
    }
  })
  it('enforces CAS and keeps audit immutable', async () => {
    const db = await fixture()
    try {
      command(db, 'one')
      expect(() => command(db, 'stale')).toThrow(/b2b_credit_version_conflict/)
      command(db, 'two', 'company', 1, 15, 200)
      expect(db.prepare('SELECT version FROM b2b_credit_terms').get()).toMatchObject({ version: 2 })
      expect(() => db.exec("DELETE FROM b2b_credit_commands WHERE command_id='one'")).toThrow()
      expect(() => db.exec('UPDATE b2b_credit_terms SET version=3')).toThrow()
    } finally {
      db.close()
    }
  })
  it('rejects unapproved companies, invalid terms and blocked without a reason', async () => {
    const db = await fixture()
    try {
      expect(() => command(db, 'pending', 'pending')).toThrow(/b2b_credit_company_not_approved/)
      expect(() => command(db, 'days', 'company', 0, 45)).toThrow()
      expect(() => command(db, 'negative', 'company', 0, 30, -1)).toThrow()
      expect(() => command(db, 'blocked', 'company', 0, 30, 100, 1)).toThrow()
      command(db, 'valid', 'company', 0, 30, 100, 1, 'Risk assessment')
    } finally {
      db.close()
    }
  })
  it('rejects revoked authority and duplicate command ids', async () => {
    const db = await fixture()
    try {
      command(db, 'one')
      expect(() => command(db, 'one', 'company', 1)).toThrow()
      db.exec("UPDATE auth_sessions SET revoked_at='2026-08-25T09:00:00Z' WHERE id='session'")
      expect(() => command(db, 'two', 'company', 1)).toThrow(/b2b_credit_authorization_changed/)
    } finally {
      db.close()
    }
  })
})
