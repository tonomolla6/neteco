// Árbol de categorías real de NETECO (ids del ERP) + raíz de menaje de demo (ids >= 100)
export const CATEGORIES: Array<[id: number, name: string, parent: number | null]> = [
  [7, 'Productos químicos', null],
  [11, 'Desengrasantes', 7],
  [10, 'Lavado manual de vajilla', 7],
  [9, 'Lavado automático de vajilla', 7],
  [23, 'Limpiadores generales', 7],
  [6, 'Multiusos', 7],
  [31, 'Tratamiento de suelos', 7],
  [17, 'Lavandería líquidos', 7],
  [16, 'Lavandería sólidos', 7],
  [18, 'Desmanchantes', 7],
  [19, 'Suavizantes y neutralizantes', 7],
  [20, 'Perfumador textil', 7],
  [5, 'Ambientadores y desodorantes', 7],
  [1, 'Marketing olfativo', 7],
  [2, 'Perfumes súper concentrados – uso en difusor', 1],
  [3, 'Perfumes – uso en pulverizador', 1],
  [4, 'Difusores de aroma', 1],
  [8, 'Línea Naturex – productos ecológicos', 7],
  [37, 'Línea eco-profesional', 7],
  [12, 'Higiene personal', 7],
  [13, 'Limpieza de manos', 12],
  [14, 'Colonias', 12],
  [15, 'Toallitas húmedas – limpieza refrescante', 12],
  [33, 'Higiene alimentaria', 7],
  [34, 'Concentrados (para diluir con agua)', 7],
  [35, 'Complementos para los concentrados', 34],
  [26, 'Cápsulas hidrosolubles', 7],
  [27, 'Box+C System – súper concentrados bag-in-box', 7],
  [28, 'Box+C · Lavado de vajillas', 27],
  [29, 'Box+C · Lavandería', 27],
  [30, 'Box+C · Complementos', 27],
  [21, 'Desincrustantes', 7],
  [22, 'Insecticidas y desinfectantes', 7],
  [24, 'Limpieza de graffitis', 7],
  [25, 'Automoción', 7],
  [32, 'Limpiadores máquina', 7],
  [36, 'Tratamiento para torres de refrigeración', 7],
  [38, 'Mantenimiento de piscinas', 7],
  [100, 'Menaje y hostelería', null],
  [101, 'Celulosa y desechables', 100],
  [102, 'Útiles de limpieza', 100],
  [103, 'Menaje de cocina', 100],
  [104, 'Guantes y protección', 100],
  [105, 'Guantes desechables', 104],
  [106, 'Guantes de trabajo y EPI', 104]
]

export interface SeedProduct {
  name: string
  cat: number
  brand?: string
  badges?: string[]
  visual: [type: string, color: string]
  featured?: boolean
  // productos hermanos (misma gama en otro color/versión) comparten `series`
  series?: string
  short: string
  desc: string
  usage?: string
  // [formato, precio en € (IVA incluido), código de artículo del ERP?]
  variants: Array<[string, number, string?]>
}

export const PRODUCTS: SeedProduct[] = [
  // ——— Guantes (tarifa real del ERP con IVA; el sku es el código de artículo del ERP) ———
  {
    name: 'Guante de nitrilo Nitriflex Blue (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-nitriflex',
    featured: true,
    visual: ['caja', '#2563eb'],
    short: 'Guante de nitrilo azul de un solo uso, ambidiestro y sin látex. Caja dispensadora de 100 unidades.',
    desc: 'Nitrilo azul flexible y resistente para limpieza, hostelería y manipulación general. Caja dispensadora de 100 guantes ambidiestros, con tallas de la XS a la XL.',
    variants: [
      ['Talla XS', 4.36, '378'],
      ['Talla S', 4.23, '1458'],
      ['Talla M', 4.23, '1133'],
      ['Talla L', 4.82, '897'],
      ['Talla XL', 4.82, '1607']
    ]
  },
  {
    name: 'Guante de nitrilo Nitriflex Black Soft (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-nitriflex',
    visual: ['caja', '#334155'],
    short: 'Guante de nitrilo negro de tacto suave. Caja dispensadora de 100 unidades.',
    desc: 'Acabado negro de la gama Nitriflex con tacto más suave y flexible. Habitual en estética, talleres y hostelería de cara al público.',
    variants: [
      ['Talla S', 4.6, '1671'],
      ['Talla M', 4.99, '910'],
      ['Talla L', 4.99, '923']
    ]
  },
  {
    name: 'Guante de nitrilo Extreme Lite azul (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-extreme-lite',
    visual: ['caja', '#38bdf8'],
    short: 'Guante de nitrilo azul ligero, gama Extreme Lite. Caja dispensadora de 100 unidades.',
    desc: 'Versión aligerada de la gama Extreme: menor gramaje y máxima sensibilidad táctil manteniendo la resistencia del nitrilo.',
    variants: [
      ['Talla M', 5.57, '1695'],
      ['Talla L', 5.57, '1640'],
      ['Talla XL', 5.57, '1720']
    ]
  },
  {
    name: 'Guante de nitrilo Extreme Lite negro (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-extreme-lite',
    visual: ['caja', '#1e293b'],
    short: 'Guante de nitrilo negro ligero, gama Extreme Lite. Caja dispensadora de 100 unidades.',
    desc: 'Versión aligerada de la gama Extreme en color negro: menor gramaje y gran sensibilidad táctil, con tallas de la S a la XL.',
    variants: [
      ['Talla S', 5.86, '1572'],
      ['Talla M', 5.86, '1719'],
      ['Talla L', 5.86, '1638'],
      ['Talla XL', 5.86, '541']
    ]
  },
  {
    name: 'Guante de nitrilo Extreme Grip naranja (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#f97316'],
    short: 'Guante de nitrilo naranja de alta visibilidad con relieve antideslizante. Caja de 100 unidades.',
    desc: 'Nitrilo de mayor espesor con textura de agarre en toda la mano, pensado para mecánica, bricolaje y trabajos en húmedo.',
    variants: [
      ['Talla M', 7.11, '2313'],
      ['Talla L', 7.22, '2191'],
      ['Talla XL', 6.75, '1932']
    ]
  },
  {
    name: 'Guante de nitrilo Dermolite azul (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-dermolite',
    visual: ['caja', '#0ea5e9'],
    short: 'Guante de nitrilo azul fino y elástico, gama Dermolite. Caja dispensadora de 100 unidades.',
    desc: 'Nitrilo de tacto fino que reduce la fatiga de la mano en usos prolongados. Tallas de la XS a la XL.',
    variants: [
      ['Talla XS', 4.38, '2312'],
      ['Talla S', 4.58, '2213'],
      ['Talla M', 4.14, '1774'],
      ['Talla L', 4.81, '2212'],
      ['Talla XL', 4.58, '2153']
    ]
  },
  {
    name: 'Guante de nitrilo Dermolite negro (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-dermolite',
    visual: ['caja', '#475569'],
    short: 'Guante de nitrilo negro fino y elástico, gama Dermolite. Caja dispensadora de 100 unidades.',
    desc: 'Versión en color negro del guante Dermolite, de tacto fino y elástico.',
    variants: [
      ['Talla S', 5.75, '2738'],
      ['Talla M', 13.01, '523'],
      ['Talla XL', 7.24, '2515']
    ]
  },
  {
    name: 'Guante de nitrilo HR 8 morado (caja 50 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-hr8',
    visual: ['caja', '#8b5cf6'],
    short: 'Guante de nitrilo morado de alto gramaje, serie HR 8. Caja de 50 unidades.',
    desc: 'Guante desechable reforzado para trabajos exigentes: mayor espesor y resistencia mecánica que un nitrilo estándar.',
    variants: [
      ['Talla L', 9.8, '1696'],
      ['Talla XL', 10.04, '1697']
    ]
  },
  {
    name: 'Guante de nitrilo HR 8 azul (caja 50 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-hr8',
    visual: ['caja', '#1d4ed8'],
    short: 'Guante de nitrilo azul de alto gramaje, serie HR 8. Caja de 50 unidades.',
    desc: 'Guante desechable reforzado de la serie HR 8 en color azul, para trabajos exigentes y usos prolongados.',
    variants: [
      ['Talla M', 15.38, '2807'],
      ['Talla L', 15.38, '2808'],
      ['Talla XL', 14.52, '2704']
    ]
  },
  {
    name: 'Guante de nitrilo Flash Power azul (caja 50 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#0284c7'],
    short: 'Guante de nitrilo azul reforzado Flash Power. Caja de 50 unidades.',
    desc: 'Nitrilo de gramaje alto en formato de 50 unidades.',
    variants: [['Talla M', 10.65, '882']]
  },
  {
    name: 'Guante de nitrilo Premium Aachen azul (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#60a5fa'],
    short: 'Guante de nitrilo azul calidad premium, línea Aachen. Caja dispensadora de 100 unidades.',
    desc: 'Nitrilo azul de gramaje medio-alto y acabado uniforme.',
    variants: [['Talla M', 6.53, '1620']]
  },
  {
    name: 'Guante de nitrilo AachenFeel negro (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#52525b'],
    short: 'Guante de nitrilo negro AachenFeel en talla XXL. Caja dispensadora de 100 unidades.',
    desc: 'Referencia en talla grande XXL para manos que no encuentran su talla en las gamas estándar.',
    variants: [['Talla XXL', 5.93, '2657']]
  },
  {
    name: 'Guante de látex con polvo (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-latex',
    visual: ['caja', '#fbbf24'],
    short: 'Guante de látex empolvado clásico. Caja dispensadora de 100 unidades.',
    desc: 'Látex natural empolvado, elástico y de fácil colocación: el desechable tradicional para limpieza y usos generales. No apto para personas alérgicas al látex.',
    variants: [
      ['Talla XS', 5.23, '1629'],
      ['Talla M', 5.03, '1564'],
      ['Talla L', 5.03, '1565'],
      ['Talla XL', 5.54, '1704']
    ]
  },
  {
    name: 'Guante de látex sin polvo (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-latex',
    visual: ['caja', '#f59e0b'],
    short: 'Guante de látex sin empolvar. Caja dispensadora de 100 unidades.',
    desc: 'Látex natural sin polvo, para usuarios y entornos donde el empolvado resulta molesto. No apto para personas alérgicas al látex.',
    variants: [
      ['Talla XS', 6.73, '2189'],
      ['Talla S', 6.74, '1567'],
      ['Talla M', 5.69, '1568'],
      ['Talla L', 6.63, '1569']
    ]
  },
  {
    name: 'Guante de vinilo sin polvo (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-vinilo',
    visual: ['caja', '#a5b4fc'],
    short: 'Guante de vinilo sin polvo. Caja dispensadora de 100 unidades.',
    desc: 'La alternativa económica y sin látex para tareas ligeras de corta duración.',
    variants: [
      ['Talla S', 3.14, '1705'],
      ['Talla L', 4.61, '1706'],
      ['Talla XL', 5.45, '1707']
    ]
  },
  {
    name: 'Guante de vinilo con polvo (caja 100 uds)',
    cat: 105,
    brand: 'NETECO',
    series: 'guantes-vinilo',
    visual: ['caja', '#94a3b8'],
    short: 'Guante de vinilo empolvado. Caja dispensadora de 100 unidades.',
    desc: 'Vinilo empolvado de fácil colocación para usos rápidos y tareas ligeras.',
    variants: [['Talla M', 4.96, '1709']]
  },
  {
    name: 'Guante de polietileno (paquete 100 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#cbd5e1'],
    short: 'Guante de polietileno transparente. Paquete de 100 unidades.',
    desc: 'Guante ultraligero de un solo uso para cambios frecuentes: gasolineras, fruterías y autoservicio.',
    variants: [['Talla única', 0.61, '1130']]
  },
  {
    name: 'Manopla higiénica de polietileno (caja 500 uds)',
    cat: 105,
    brand: 'NETECO',
    visual: ['caja', '#14b8a6'],
    short: 'Manopla higiénica de polietileno de 40 micras. Caja de 500 unidades.',
    desc: 'Manopla desechable para dispensadores de autoservicio: panadería, frutería y charcutería.',
    variants: [['Talla única', 31.27, '2344']]
  },
  {
    name: 'Guante de neopreno flocado negro (par)',
    cat: 106,
    brand: 'NETECO',
    visual: ['guante', '#334155'],
    short: 'Guante reutilizable de neopreno con interior flocado. Se vende por pares.',
    desc: 'Guante de neopreno resistente a los productos químicos de limpieza, con interior flocado que facilita la colocación. Para limpieza intensiva y manejo de químicos diluidos.',
    variants: [['Talla única', 11.74, '2865']]
  },
  {
    name: 'Guante ignífugo azul (par)',
    cat: 106,
    brand: 'NETECO',
    visual: ['guante', '#2563eb'],
    short: 'Guante de protección ignífuga. Se vende por pares.',
    desc: 'Guante ignífugo azul para manipulación en caliente. Consultar la ficha del fabricante para los niveles de protección certificados.',
    variants: [['Talla única', 14.35, '1195']]
  }
]
