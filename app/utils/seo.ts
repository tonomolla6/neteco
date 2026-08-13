type RouteQuery = Record<string, unknown>

function paginationNumber(query: RouteQuery): number | null {
  const raw = Array.isArray(query.page) ? query.page[0] : query.page
  const value = String(raw ?? '')
  if (!/^[1-9]\d*$/.test(value)) return null
  return Number(value)
}

export function canonicalPath(path: string, query: RouteQuery): string {
  const base = path === '/' ? '/' : path.replace(/\/$/, '')
  const supportsPagination = base === '/catalogo' || base.startsWith('/categoria/')
  const page = supportsPagination ? paginationNumber(query) : null
  return page && page > 1 ? `${base}?page=${page}` : base
}

export function isIndexableCatalogQuery(query: RouteQuery): boolean {
  const keys = Object.keys(query)
  return keys.length === 0 || (keys.length === 1 && keys[0] === 'page' && paginationNumber(query) !== null)
}
