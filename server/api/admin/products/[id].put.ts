import { updateCatalogProduct } from '../../../services/catalog-admin'

export default defineEventHandler(async (event) => {
  const administrator = await requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, productInput.parse)
  try {
    const product = await updateCatalogProduct(
      id,
      body,
      administrator,
      event.context.correlationId ?? crypto.randomUUID()
    )
    if (!product) throw createError({ statusCode: 404, statusMessage: 'Producto no encontrado' })
    return product
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'Hay una referencia o URL que ya existe' })
    }
    throw error
  }
})
