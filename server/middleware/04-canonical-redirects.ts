import { useDatabase } from '../db/client'

export default defineEventHandler(async (event) => {
  if (!['GET', 'HEAD'].includes(event.method.toUpperCase())) return
  const request = getRequestURL(event)
  if (!request.pathname.startsWith('/producto/') && !request.pathname.startsWith('/categoria/')) return
  const sql = useDatabase()
  const [redirect] = await sql<{ destination: string; statusCode: 301 | 308 }[]>`
    SELECT destination_path AS destination, status_code AS "statusCode"
    FROM canonical_redirects WHERE source_path = ${request.pathname}
  `
  if (!redirect) return
  const location = new URL(redirect.destination, request.origin)
  location.search = request.search
  return sendRedirect(event, `${location.pathname}${location.search}`, redirect.statusCode)
})
