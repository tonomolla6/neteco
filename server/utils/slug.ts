import type { Database } from 'better-sqlite3'

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function ensureUniqueSlug(
  db: Database,
  table: 'products' | 'categories',
  base: string,
  excludeId?: number
) {
  const clean = base || 'sin-nombre'
  const exists = (s: string) =>
    excludeId != null
      ? db.prepare(`SELECT 1 FROM ${table} WHERE slug = ? AND id != ?`).get(s, excludeId)
      : db.prepare(`SELECT 1 FROM ${table} WHERE slug = ?`).get(s)
  let slug = clean
  let i = 2
  while (exists(slug)) slug = `${clean}-${i++}`
  return slug
}
