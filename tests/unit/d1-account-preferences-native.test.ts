import { readFile, readdir } from 'node:fs/promises'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { it, expect } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  readD1AccountPreferences,
  updateD1AccountPreferences,
  readD1AccountPreferenceCommand
} from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { preferenceSeeds, CLAIMS, OPTIONS, KEY } from './d1-account-preferences-fixture'
it('uses actual workerd D1 for default read, atomic consent/CAS, replay and receipt without newsletter effects', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'account-preferences-native',
      modules: true,
      script: 'export default{fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000066' },
      outboundService: () => {
        throw new Error('unexpected_outbound')
      }
    })
  )
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    for (const name of (await readdir('db/d1/migrations'))
      .filter((n) => /^\d+.*\.sql$/.test(n) && (Number(n.slice(0, 4)) <= 62 || n === '0066_account_preferences.sql'))
      .sort()) {
      const sql = splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8'))
      for (let i = 0; i < sql.length; i += 50) await db.batch(sql.slice(i, i + 50).map((s) => db.prepare(s)))
    }
    await db.batch(preferenceSeeds().map((s) => db.prepare(s)))
    expect(await readD1AccountPreferences(db, CLAIMS, OPTIONS)).toMatchObject({ version: 0, updatedAt: null })
    const input = {
      expectedVersion: 0,
      preferences: { product_updates: true, replenishment: false },
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
    }
    const receipt = await updateD1AccountPreferences(db, CLAIMS, KEY, input, OPTIONS)
    expect(await updateD1AccountPreferences(db, CLAIMS, KEY, input, OPTIONS)).toEqual(receipt)
    expect(await readD1AccountPreferenceCommand(db, CLAIMS, KEY, OPTIONS)).toMatchObject({
      outcome: 'applied',
      receipt
    })
    expect(await readD1AccountPreferences(db, CLAIMS, OPTIONS)).toMatchObject({
      version: 1,
      preferences: input.preferences
    })
    expect(await db.prepare('SELECT count(*) n FROM account_preference_commands').first()).toEqual({ n: 1 })
    expect(await db.prepare('SELECT count(*) n FROM newsletter_subscriptions').first()).toEqual({ n: 0 })
  } finally {
    await runtime.dispose()
  }
}, 30000)
