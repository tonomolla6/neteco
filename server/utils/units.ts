// Contenido del envase para poder mostrar el precio por unidad/litro/kilo
// (se deduce del formato; para tallas de guantes, del envase indicado en el nombre)
export function unitsFor(format: string, productName: string): [number, string] | null {
  const f = format.toLowerCase()
  let m = f.match(/([\d.,]+)\s*ml\b/)
  if (m) return [parseFloat(m[1]!.replace(',', '.')) / 1000, 'L']
  m = f.match(/([\d.,]+)\s*l\b/)
  if (m) return [parseFloat(m[1]!.replace(',', '.')), 'L']
  m = f.match(/([\d.,]+)\s*kg\b/)
  if (m) return [parseFloat(m[1]!.replace(',', '.')), 'kg']
  m = f.match(/(\d+)\s*(?:unidades|uds|cápsulas|bobinas)/)
  if (m) return [parseInt(m[1]!), 'ud']
  m = productName.toLowerCase().match(/\((?:caja|paquete)\s+(\d+)\s*uds\)/)
  if (m) return [parseInt(m[1]!), 'ud']
  return null
}
