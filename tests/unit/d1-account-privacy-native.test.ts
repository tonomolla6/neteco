import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  executeD1AccountPrivacy,
  readD1AccountPrivacy,
  downloadD1AccountPrivacy
} from '../../workers/auth/account-privacy'
it('executes privacy requests and minimized export on actual workerd D1', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'privacy-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000065' },
      outboundService: () => {
        throw new Error('unexpected_outbound')
      }
    })
  )
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 156 }, (_, index) => index + 1)
    )
    for (const name of migrations.slice(0, 71)) {
      const sql = splitDemoSql(await readFile(`db/d1/migrations/${name}`, 'utf8'))
      // In particular 0071's deferred FK rebuild is one atomic migration.
      await db.batch(sql.map((s) => db.prepare(s)))
    }
    const clock = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') now,strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 hour') expires")
      .first<{ now: string; expires: string }>()
    if (!clock) throw new Error('clock_missing')
    const customer = '30000000-0000-4000-8000-000000000065',
      identity = '10000000-0000-4000-8000-000000000065',
      session = '20000000-0000-4000-8000-000000000065',
      key = '40000000-0000-4000-8000-000000000065'
    await db.batch([
      db
        .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
        .bind(customer, 'Native owner', clock.now, clock.now),
      db
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'native@example.invalid','synthetic',?,'active',?,?,?)"
        )
        .bind(identity, clock.now, customer, clock.now, clock.now),
      db
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
        )
        .bind(session, identity, clock.now, clock.expires)
    ])
    const claims = { identityId: identity, sessionId: session, sessionVersion: 1 },
      input = { requestType: 'export', idempotencyKey: key }
    const receipt = await executeD1AccountPrivacy(db, claims, input)
    expect(await executeD1AccountPrivacy(db, claims, input)).toEqual(receipt)
    expect(await readD1AccountPrivacy(db, claims)).toMatchObject({ requests: [receipt] })
    expect(await downloadD1AccountPrivacy(db, claims, receipt.id)).toMatchObject({
      profile: { email: 'native@example.invalid', name: 'Native owner' },
      addresses: [],
      orders: [],
      favorites: [],
      securityNotices: []
    })
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(clock.now, session).run()
    await expect(downloadD1AccountPrivacy(db, claims, receipt.id)).rejects.toMatchObject({ code: 'unauthenticated' })
  } finally {
    await runtime.dispose()
  }
})
