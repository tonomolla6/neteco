import { structuredLog } from '../utils/log'

export default defineEventHandler((event) => {
  const startedAt = performance.now()
  event.node.res.once('finish', () => {
    const path = getRequestURL(event).pathname
    structuredLog(
      event.node.res.statusCode >= 500 ? 'error' : event.node.res.statusCode >= 400 ? 'warn' : 'info',
      'http.request.completed',
      {
        correlationId: event.context.correlationId,
        method: event.method,
        path,
        statusCode: event.node.res.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100
      }
    )
  })
})
