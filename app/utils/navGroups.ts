// Agrupación temática de las familias para el mega-menú.
// Las familias que no estén en ningún grupo caen en «Más familias»,
// así el menú no se rompe cuando el admin cree categorías nuevas.
const NAV_GROUPS: Array<{ title: string; slugs: string[] }> = [
  {
    title: 'Cocina y vajilla',
    slugs: [
      'lavado-manual-de-vajilla',
      'lavado-automatico-de-vajilla',
      'desengrasantes',
      'higiene-alimentaria'
    ]
  },
  {
    title: 'Superficies y suelos',
    slugs: [
      'limpiadores-generales',
      'multiusos',
      'tratamiento-de-suelos',
      'limpiadores-maquina',
      'desincrustantes',
      'limpieza-de-graffitis'
    ]
  },
  {
    title: 'Lavandería',
    slugs: [
      'lavanderia-liquidos',
      'lavanderia-solidos',
      'desmanchantes',
      'suavizantes-y-neutralizantes',
      'perfumador-textil'
    ]
  },
  {
    title: 'Ambiente e higiene',
    slugs: [
      'ambientadores-y-desodorantes',
      'marketing-olfativo',
      'higiene-personal',
      'insecticidas-y-desinfectantes'
    ]
  },
  {
    title: 'Líneas y sistemas',
    slugs: [
      'linea-eco-profesional',
      'linea-naturex-productos-ecologicos',
      'box-c-system-super-concentrados-bag-in-box',
      'concentrados-para-diluir-con-agua',
      'capsulas-hidrosolubles'
    ]
  },
  {
    title: 'Sectores específicos',
    slugs: ['automocion', 'mantenimiento-de-piscinas', 'tratamiento-para-torres-de-refrigeracion']
  }
]

export function groupFamilies(children: Array<{ slug: string; [k: string]: any }>) {
  const bySlug = new Map(children.map((c) => [c.slug, c]))
  const used = new Set<string>()
  const groups = NAV_GROUPS.map((g) => ({
    title: g.title,
    items: g.slugs
      .map((s) => {
        used.add(s)
        return bySlug.get(s)
      })
      .filter(Boolean) as any[]
  })).filter((g) => g.items.length)
  const rest = children.filter((c) => !used.has(c.slug))
  if (rest.length) groups.push({ title: 'Más familias', items: rest })
  return groups
}
