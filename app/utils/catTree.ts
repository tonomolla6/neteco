// Aplana el árbol de categorías del API en opciones indentadas para selects del backoffice
export function flattenCategoryTree(roots: any[]): Array<{ id: number; label: string; depth: number }> {
  const out: Array<{ id: number; label: string; depth: number }> = []
  const walk = (nodes: any[], depth: number) => {
    for (const n of nodes ?? []) {
      out.push({ id: n.id, label: `${'  '.repeat(depth)}${depth ? '└ ' : ''}${n.name}`, depth })
      walk(n.children, depth + 1)
    }
  }
  walk(roots, 0)
  return out
}
