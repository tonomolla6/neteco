export const NOINDEX_HEADER = 'noindex, nofollow, noarchive'

export const PRIVATE_ROBOTS_PREFIXES = [
  '/admin',
  '/cuenta',
  '/carrito',
  '/checkout',
  '/pedido',
  '/pedidos',
  '/pago',
  '/auth',
  '/login',
  '/registro',
  '/recuperar-clave',
  '/restablecer-clave',
  '/verificar-email',
  '/buscar',
  '/newsletter',
  '/reparto',
  '/encuesta',
  '/comparar'
] as const

export function isPrivateRobotsPath(path: string): boolean {
  const normalized = path.split('?')[0]?.replace(/\/+$/, '') || '/'
  return PRIVATE_ROBOTS_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

export function robotsHeader(appEnv: string, path: string): string | null {
  return appEnv !== 'production' || isPrivateRobotsPath(path) ? NOINDEX_HEADER : null
}
