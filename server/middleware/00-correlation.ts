import { randomUUID } from 'node:crypto'

export default defineEventHandler((event) => {
  const supplied = getHeader(event, 'x-correlation-id')
  const correlationId = supplied && /^[a-f0-9-]{16,64}$/i.test(supplied) ? supplied : randomUUID()
  event.context.correlationId = correlationId
  setHeader(event, 'x-correlation-id', correlationId)
})
