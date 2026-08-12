import { useDatabase } from '../../db/client'

export default defineEventHandler(async (event) => {
  try {
    const database = useDatabase()
    await database`SELECT 1 AS ready`
    return { status: 'ready', correlationId: event.context.correlationId }
  } catch {
    setResponseStatus(event, 503)
    return { status: 'not_ready', correlationId: event.context.correlationId }
  }
})
