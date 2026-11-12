import { productDeliveryRequestSchema } from '../../../shared/delivery-estimate'
import { quoteProductDelivery } from '../../services/shipping'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, productDeliveryRequestSchema.parse)
  return quoteProductDelivery(body)
})
