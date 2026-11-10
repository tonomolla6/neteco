import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { publicationValidityExpression } from '../../workers/catalog/publication-validity'

describe('publication authority on native D1', () => {
  it('does not authorize a product lacking publication evidence on native D1', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'npm-audit2-publication',
        script: 'export default {fetch(){return new Response("isolated")}}',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000043' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = await runtime.getD1Database('DB')
      for (const name of (await readdir('db/d1/migrations'))
        .filter((name) => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 36)
        .sort()) {
        const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < statements.length; index += 50) {
          await database.batch(statements.slice(index, index + 50).map((statement) => database.prepare(statement)))
        }
      }
      await database.batch([
        database.prepare("INSERT INTO categories(id,name,slug) VALUES ('category','Synthetic','synthetic')"),
        database.prepare(
          "INSERT INTO products(id,category_id,name,slug) VALUES ('product','category','Synthetic','synthetic')"
        )
      ])
      const result = await database
        .prepare(`SELECT ${publicationValidityExpression('p')} AS valid FROM products p`)
        .all()
      expect(result.results).toEqual([{ valid: 0 }])
    } finally {
      await runtime.dispose()
    }
  })
})
