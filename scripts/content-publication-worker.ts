import postgres from 'postgres'
import { runDueContentPublications } from '../server/services/content-publication'
import { applicationNow } from '../server/utils/application-clock'

const connection = process.env.DATABASE_URL?.trim()
if (!connection) throw new Error('DATABASE_URL is required')
const sql = postgres(connection, { max: 2, connect_timeout: 10 })
try {
  const actions = await runDueContentPublications(sql, applicationNow())
  process.stdout.write(`${JSON.stringify({ processed: actions.length, actions })}\n`)
} finally {
  await sql.end({ timeout: 5 })
}
