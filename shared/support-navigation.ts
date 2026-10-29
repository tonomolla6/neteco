/** A SPA transition does not replace document CSP headers. Keep challenge
 * permissions scoped to contact by requiring a fresh native contact document. */
export function supportContactDocumentTarget(
  runtime: unknown,
  documentPath: string,
  target: { path: string; fullPath: string }
): string | null {
  const prefix = /^\/contacto\/?(?=[?#]|$)/i.exec(target.fullPath)?.[0]
  if (runtime !== 'cloudflare' || !/^\/contacto\/?$/i.test(target.path) || !prefix) return null
  let current = documentPath
  try {
    for (let round = 0; round < 4; round++) {
      const decoded = decodeURIComponent(current)
      if (decoded === current) break
      current = decoded
    }
  } catch {
    /* Unknown document requires a fresh, safe contact navigation. */
  }
  return /^\/contacto\/?$/i.test(current) ? null : `/contacto${target.fullPath.slice(prefix.length)}`
}
