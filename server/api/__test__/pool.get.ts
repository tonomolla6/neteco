import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  if (process.env.APP_ENV !== 'test') throw createError({ statusCode: 404, statusMessage: 'Not found' })
  const holdMs = Number(getQuery(event).holdMs ?? 0)
  if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > 250) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid test hold time' })
  }
  const sql = useDatabase()
  const [row] = await sql<{ backendPid: number }[]>`
    SELECT pg_backend_pid()::int AS "backendPid", pg_sleep(${holdMs / 1000})
  `
  return row
})
