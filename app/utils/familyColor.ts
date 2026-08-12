// Color de cada familia: la firma visual de la tienda ("cada familia, con su color").
// Reutiliza los hex de las ilustraciones del seed; al importar el catálogo real
// este mapa puede pasar a una columna `color` en la tabla de categorías.
const FAMILY_COLORS: Record<string, string> = {
  'productos-quimicos': '#009ac9',
  desengrasantes: '#f97316',
  'lavado-manual-de-vajilla': '#009ac9',
  'lavado-automatico-de-vajilla': '#0369a1',
  'limpiadores-generales': '#22d3ee',
  multiusos: '#facc15',
  'tratamiento-de-suelos': '#10b981',
  'lavanderia-liquidos': '#7c3aed',
  'lavanderia-solidos': '#6d28d9',
  desmanchantes: '#e11d48',
  'suavizantes-y-neutralizantes': '#d946ef',
  'perfumador-textil': '#ec4899',
  'ambientadores-y-desodorantes': '#f472b6',
  'marketing-olfativo': '#8b5cf6',
  'linea-naturex-productos-ecologicos': '#16a34a',
  'linea-eco-profesional': '#15803d',
  'higiene-personal': '#06b6d4',
  'higiene-alimentaria': '#65a30d',
  'concentrados-para-diluir-con-agua': '#0284c7',
  'capsulas-hidrosolubles': '#0891b2',
  'box-c-system-super-concentrados-bag-in-box': '#0a536e',
  desincrustantes: '#f43f5e',
  'insecticidas-y-desinfectantes': '#84cc16',
  'limpieza-de-graffitis': '#ef4444',
  automocion: '#3b82f6',
  'limpiadores-maquina': '#52525b',
  'tratamiento-para-torres-de-refrigeracion': '#334155',
  'mantenimiento-de-piscinas': '#0e7490',
  'menaje-y-hosteleria': '#45b5e5',
  'celulosa-y-desechables': '#38bdf8',
  'utiles-de-limpieza': '#f59e0b',
  'menaje-de-cocina': '#ea580c',
  'guantes-y-proteccion': '#6366f1',
  'guantes-desechables': '#818cf8',
  'guantes-de-trabajo-y-epi': '#4f46e5'
}

export function familyColor(slug: string): string {
  return FAMILY_COLORS[slug] ?? '#009ac9'
}
