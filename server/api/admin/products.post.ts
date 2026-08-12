import { createCatalogProduct } from '../../services/catalog-admin'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const body = await readValidatedBody(event, productInput.parse)
  try {
    const product = await createCatalogProduct(body, administrator, event.context.correlationId ?? crypto.randomUUID())
    setResponseStatus(event, 201)
    return product
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Hay una referencia o URL que ya existe' })
    }
    throw error
  }
})
