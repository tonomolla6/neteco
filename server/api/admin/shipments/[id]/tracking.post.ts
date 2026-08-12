import { syncShipmentTracking } from '../../../../services/shipping'

export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  return syncShipmentTracking(String(getRouterParam(event, 'id')), event.context.correlationId ?? crypto.randomUUID())
})
