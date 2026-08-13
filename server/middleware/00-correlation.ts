import { randomUUID } from 'node:crypto'

export default defineEventHandler((event) => {
  const supplied = getHeader(event, 'x-correlation-id')
  const correlationId =
    supplied && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(supplied)
      ? supplied
      : randomUUID()
  event.context.correlationId = correlationId
  setHeader(event, 'x-correlation-id', correlationId)
})
