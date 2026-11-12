/**
 * «Tus habituales»: las referencias que un cliente repite, calculadas con sus propios
 * pedidos. La prueba social más creíble en reposición es el historial de uno mismo.
 *
 * Orden: en cuántos pedidos aparece la referencia, después el más reciente. La cantidad
 * habitual es la que más se repite (a igualdad, la última). Una línea que ya no se puede
 * pedir no se ofrece.
 */
export interface HabitualOrderLine {
  sku: string
  name: string
  format: string
  quantity: number
  unitGross: number
  variantId: number | null
  slug: string | null
  image: string | null
  imageAlt?: string | null
  visual: { type: string; color: string } | null
  available: boolean
}
export interface HabitualProduct {
  variantId: number
  sku: string
  name: string
  format: string
  slug: string | null
  image: string | null
  imageAlt: string | null
  visual: { type: string; color: string } | null
  /** Precio unitario con IVA del último pedido; el carrito confirma el actual. */
  lastUnitGross: number
  timesOrdered: number
  usualQuantity: number
  lastQuantity: number
  lastOrderedAt: string
}

export function rankHabitualLines(
  orders: ReadonlyArray<{ orderedAt: string; lines: ReadonlyArray<HabitualOrderLine> }>,
  limit = 6
): HabitualProduct[] {
  const byRecency = [...orders].sort((left, right) => right.orderedAt.localeCompare(left.orderedAt))
  const products = new Map<number, HabitualProduct & { quantities: number[]; unavailable: boolean }>()
  for (const order of byRecency) {
    const perOrder = new Map<number, { line: HabitualOrderLine; quantity: number }>()
    for (const line of order.lines) {
      if (line.variantId === null) continue
      const seen = perOrder.get(line.variantId)
      if (seen) seen.quantity += line.quantity
      else perOrder.set(line.variantId, { line, quantity: line.quantity })
    }
    for (const [variantId, { line, quantity }] of perOrder) {
      const known = products.get(variantId)
      if (known) {
        known.timesOrdered++
        known.quantities.push(quantity)
        continue
      }
      // El pedido más reciente manda: es el que dice el nombre, el precio y si aún se vende.
      products.set(variantId, {
        variantId,
        sku: line.sku,
        name: line.name,
        format: line.format,
        slug: line.slug,
        image: line.image,
        imageAlt: line.imageAlt ?? null,
        visual: line.visual,
        lastUnitGross: line.unitGross,
        timesOrdered: 1,
        usualQuantity: quantity,
        lastQuantity: quantity,
        lastOrderedAt: order.orderedAt,
        quantities: [quantity],
        unavailable: !line.available
      })
    }
  }
  return [...products.values()]
    .filter((product) => !product.unavailable)
    .map(({ quantities, unavailable: _unavailable, ...product }) => {
      const counts = new Map<number, number>()
      for (const quantity of quantities) counts.set(quantity, (counts.get(quantity) ?? 0) + 1)
      // `quantities` va del pedido más reciente al más antiguo: a igualdad gana el primero.
      let usualQuantity = quantities[0]!
      for (const quantity of quantities)
        if (counts.get(quantity)! > counts.get(usualQuantity)!) usualQuantity = quantity
      return { ...product, usualQuantity }
    })
    .sort(
      (left, right) => right.timesOrdered - left.timesOrdered || right.lastOrderedAt.localeCompare(left.lastOrderedAt)
    )
    .slice(0, limit)
}
