import { readFile, readdir } from 'node:fs/promises'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { it, expect } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  listD1AdminCompanies,
  executeD1CompanyReview,
  readD1CompanyReviewCommand
} from '../../workers/auth/admin-companies'
import { seedStatements, CLAIMS, COMPANY, KEY, INPUT, OPTIONS } from './d1-admin-companies-fixture'
it('runs bounded literal search and atomic audited CAS on actual workerd D1', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'company-review-native',
      modules: true,
      script: 'export default{fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000064' },
      outboundService: () => {
        throw new Error('unexpected_outbound')
      }
    })
  )
  try {
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    for (const name of (await readdir('db/d1/migrations')).filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8'))
      for (let i = 0; i < sql.length; i += 50) await db.batch(sql.slice(i, i + 50).map((s) => db.prepare(s)))
    }
    await db.batch(seedStatements().map((sql) => db.prepare(sql)))
    expect(await listD1AdminCompanies(db, CLAIMS, { q: 'acido' }, OPTIONS)).toMatchObject({ total: 1 })
    expect(await listD1AdminCompanies(db, CLAIMS, { q: '%_\\' }, OPTIONS)).toMatchObject({ total: 1 })
    const long = 'Company ' + 'a'.repeat(80)
    await db.prepare('UPDATE companies SET legal_name=? WHERE id=?').bind(long, COMPANY).run()
    expect(await listD1AdminCompanies(db, CLAIMS, { q: long, perPage: 1 }, OPTIONS)).toMatchObject({
      total: 1,
      items: [{ id: COMPANY }]
    })
    const receipt = await executeD1CompanyReview(db, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)
    expect(await executeD1CompanyReview(db, CLAIMS, COMPANY, KEY, INPUT, OPTIONS)).toEqual(receipt)
    expect(await readD1CompanyReviewCommand(db, CLAIMS, COMPANY, KEY, OPTIONS)).toMatchObject({
      outcome: 'applied',
      receipt
    })
    expect(await db.prepare('SELECT status,last_change_id FROM companies WHERE id=?').bind(COMPANY).first()).toEqual({
      status: 'approved',
      last_change_id: KEY
    })
    expect(await db.prepare('SELECT count(*) n FROM company_admin_review_commands').first()).toEqual({ n: 1 })
  } finally {
    await runtime.dispose()
  }
}, 30000)
