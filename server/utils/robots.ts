export const NOINDEX_HEADER = 'noindex, nofollow, noarchive'

export function robotsHeader(appEnv: string, path: string): string | null {
  return appEnv !== 'production' || path.startsWith('/admin') ? NOINDEX_HEADER : null
}
