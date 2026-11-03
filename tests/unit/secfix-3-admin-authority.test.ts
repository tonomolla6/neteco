import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { handleProductReviewsQaHttp } from '../../workers/catalog/product-reviews-qa-http'
import { handleProductMediaGuidesHttp } from '../../workers/catalog/product-media-guides-http'

// SECFIX-3 findings 16 + 17: admin authority must honour role expiry, identity status and session state.
const now = '2026-10-29T12:00:00Z'
let sqlite: DatabaseSync
let database: D1Database

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  seedInventoryFixture(sqlite)
  sqlite.exec(await readFile('db/d1/migrations/0113_product_reviews_qa_and_media_guides.sql', 'utf8'))
  database = d1OverSqlite(sqlite)
  sqlite.exec(`
    INSERT INTO identities(id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('id-valid', 'valid@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-expired-role', 'expired@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}'),
      ('id-suspended', 'suspended@example.invalid', 'syn', '${now}', 'disabled', 1, '${now}', '${now}'),
      ('id-revoked', 'revoked@example.invalid', 'syn', '${now}', 'active', 1, '${now}', '${now}');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at, revoked_at) VALUES
      ('sess-valid', 'id-valid', 1, 1, '${now}', '2026-10-30T12:00:00Z', NULL),
      ('sess-expired-role', 'id-expired-role', 1, 1, '${now}', '2026-10-30T12:00:00Z', NULL),
      ('sess-suspended', 'id-suspended', 1, 1, '${now}', '2026-10-30T12:00:00Z', NULL),
      ('sess-revoked', 'id-revoked', 1, 1, '${now}', '2026-10-30T12:00:00Z', '${now}');
    INSERT INTO permissions(code, resource, action, description) VALUES('support.manage','support','manage','S')
      ON CONFLICT DO NOTHING;
    INSERT INTO roles(code, name, description) VALUES('operator','Operator','S') ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(role_code, permission_code) VALUES('operator','support.manage') ON CONFLICT DO NOTHING;
    INSERT INTO identity_roles(identity_id, role_code, granted_at, expires_at) VALUES
      ('id-valid', 'operator', '2026-10-01T00:00:00Z', NULL),
      ('id-expired-role', 'operator', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
      ('id-suspended', 'operator', '2026-10-01T00:00:00Z', NULL),
      ('id-revoked', 'operator', '2026-10-01T00:00:00Z', NULL);
  `)
})

afterEach(() => sqlite.close())

const resolverFor = (who: string) => async () => ({
  identityId: `id-${who}`,
  sessionId: `sess-${who}`,
  sessionVersion: 1,
  customerId: null
})

const cases = [
  {
    name: 'GET /api/admin/reviews (finding 16)',
    call: (who: string) =>
      handleProductReviewsQaHttp(new Request('https://tienda.example.com/api/admin/reviews'), {
        database,
        now: () => now,
        sessionClaimsResolver: resolverFor(who)
      } as never)
  },
  {
    name: 'GET /api/admin/media/guides (finding 17)',
    call: (who: string) =>
      handleProductMediaGuidesHttp(new Request('https://tienda.example.com/api/admin/media/guides'), {
        database,
        now: () => now,
        sessionClaimsResolver: resolverFor(who)
      } as never)
  }
]

describe.each(cases)('SECFIX-3 $name', ({ call }) => {
  it('allows an active identity with a current grant on a live session', async () => {
    expect((await call('valid'))?.status).toBe(200)
  })

  it.each(['expired-role', 'suspended', 'revoked'])('denies %s', async (who) => {
    expect((await call(who))?.status).toBe(403)
  })
})
