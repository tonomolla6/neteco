import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { promotionRuleSchema, type PromotionRule } from '../../shared/promotions'
import { promotionRuleHash } from '../../workers/catalog/promotions'
import { d1OverSqlite } from './d1-sqlite'
import { testNow } from './deterministic'

/** Synthetic administrative configuration only, before any quote/order exists. */
export async function provisionPromotionFixture(sqlite: DatabaseSync, input: PromotionRule, actorId: string) {
  const rule = promotionRuleSchema.parse(input)
  if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='promotion_rules'").get()) {
    const sql = await readFile(new URL('../../db/d1/migrations/0072_promotions.sql', import.meta.url), 'utf8')
    const database = d1OverSqlite(sqlite)
    await database.batch(splitDemoSql(sql).map((statement) => database.prepare(statement)))
  }
  const now = new Date(testNow()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const ruleHash = await promotionRuleHash(rule)
  sqlite
    .prepare('INSERT INTO promotion_rules(id,code,current_version,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(rule.id, rule.code, rule.version, now, now)
  sqlite
    .prepare(
      'INSERT INTO promotion_rule_versions(rule_id,version,rule_json,rule_hash,created_by,created_at) VALUES(?,?,?,?,?,?)'
    )
    .run(rule.id, rule.version, JSON.stringify(rule), ruleHash, actorId, now)
  return { rule, ruleHash }
}
