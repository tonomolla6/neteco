import { useDatabase } from '../../../db/client'
import { saveCustomerFavorite, saveFavoriteSchema } from '../../../services/favorites'
import { requireCustomerAccount } from '../../../utils/account'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, saveFavoriteSchema.parse)
  const account = await requireCustomerAccount(event)
  const item = await useDatabase().begin((transaction) => saveCustomerFavorite(transaction, account.customerId, body))
  setResponseStatus(event, 201)
  return item
})
