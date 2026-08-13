import { z } from 'zod'
import { reconcileBankTransferManually } from '../../../../../services/orders'
import { requirePermission } from '../../../../../utils/auth-session'

const schema = z
  .object({
    orderNumber: z
      .string()
      .trim()
      .regex(/^NE[A-F0-9]{10}$/i),
    reason: z.string().trim().min(3).max(500)
  })
  .strict()

export default defineEventHandler(async (event) => {
  const authenticated = await requirePermission(event, 'reconciliation.manage', { mfa: true })
  const movementId = String(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, schema.parse)
  return reconcileBankTransferManually({
    movementId,
    publicNumber: body.orderNumber,
    actorId: authenticated.profile.id,
    reason: body.reason,
    correlationId: event.context.correlationId ?? crypto.randomUUID()
  })
})
