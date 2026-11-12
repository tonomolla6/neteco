/**
 * Los productos de la demo original (guantes y químicos de muestra) conservan sus
 * identificadores bajos; el catálogo real se carga a partir del 1000. No se enseñan en los
 * escaparates de la portada: son datos de prueba, no surtido que se quiera destacar.
 */
const FIRST_CATALOG_PRODUCT_ID = 1000

export function isDemoProduct(product: { id: number }): boolean {
  return product.id < FIRST_CATALOG_PRODUCT_ID
}
