import { adminAuditFixture, ADMIN, RECIPIENT, utc } from './d1-admin-audit-fixture'
import { readFile } from 'node:fs/promises'
export { ADMIN, utc }
export const OTHER = RECIPIENT
export const ORIGIN = 'https://order-views.neteco.test'
export const DEFINITION = {
  bucket: 'todos' as const,
  sortKey: 'createdAt' as const,
  sortDir: 'desc' as const,
  columns: ['createdAt', 'customer', 'total'] as ('createdAt' | 'customer' | 'total')[]
}
export async function orderViewsFixture() {
  const f = await adminAuditFixture()
  f.sqlite.exec(
    'BEGIN;\n' +
      (await readFile(new URL('../../db/d1/migrations/0085_admin_order_views.sql', import.meta.url), 'utf8')) +
      '\nCOMMIT;'
  )
  f.sqlite.prepare("INSERT INTO identity_roles VALUES(?,'admin',NULL,?,NULL)").run(OTHER.identityId, utc(-60000))
  return {
    ...f,
    input: { name: 'Preparación diaria', definition: DEFINITION },
    deps: { ...f.deps, origin: ORIGIN, rateLimitPepper: 'synthetic-order-views-pepper-0123456789abcdef' }
  }
}
