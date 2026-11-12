/**
 * Dónde se pinta la barra inferior móvil. Queda fuera donde ya hay una barra de compra fija
 * (ficha de producto, carrito), en el pago y en el panel de administración.
 */
export function appBottomBarVisible(path: string): boolean {
  return !['/checkout', '/carrito', '/producto', '/admin', '/pago', '/reparto'].some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  )
}
