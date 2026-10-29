import { unstable_splitSqlQuery } from 'wrangler'

/** Wrangler 4.124's compound-statement splitter misses END immediately before
 * a comma/parenthesis. Add harmless token whitespace, preserving literals and
 * comments verbatim. Schema files themselves are never rewritten. */
export function splitDemoSql(sql: string) {
  const compatible = sql.replace(
    /('(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/)|\bEND(?=[,)])/gi,
    (token, quoted: string | undefined) => (quoted === undefined ? `${token} ` : token)
  )
  return unstable_splitSqlQuery(compatible).filter(
    (statement) => !/^\s*(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;?\s*$/i.test(statement)
  )
}
