<script setup lang="ts">
import type { CategoryResponse, ProductCardData, ProductListResponse, ProductSummary } from '~~/shared/types/catalog'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'
import type { HomeFamilyTile } from '~/components/home/HomeFamilyTiles.vue'
import type { HomeImage } from '~/utils/homeImages'

const homeTitle = 'Suministros profesionales de limpieza e higiene'
const homeDescription =
  'Tienda online de NETECO: químicos de limpieza, celulosa, higiene y menaje profesional para hostelería e industria en Ontinyent y España.'

useSeoMeta({
  title: homeTitle,
  description: homeDescription,
  ogTitle: `${homeTitle} · NETECO`,
  ogDescription: homeDescription,
  twitterTitle: `${homeTitle} · NETECO`,
  twitterDescription: homeDescription
})

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
const { data: featured } = await useFetch<ProductListResponse>('/api/products', {
  key: 'featured',
  params: { featured: 1, limit: 12 }
})

/**
 * Muestra amplia del catálogo, ordenada como lo ordena la tienda (destacados primero).
 * Alimenta las ofertas, el relleno de destacados y la foto de reserva de cada familia, con
 * una sola petición en lugar de una por bloque.
 */
const { data: poolData } = await useFetch<ProductListResponse>('/api/products', {
  key: 'home-pool',
  params: { limit: 60 }
})
/**
 * Lo que se enseña en la portada: ni los productos de la demo original ni lo que no se
 * puede servir. Un escaparate con artículos de prueba o agotados resta confianza.
 */
const showable = (item: ProductSummary) => !isDemoProduct(item) && listingOrderable(item)
const pool = computed(() => ((poolData.value?.items ?? []) as ProductSummary[]).filter(showable))
const featuredItems = computed(() => ((featured.value?.items ?? []) as ProductSummary[]).filter(showable))

/**
 * Ofertas: solo las que tienen un ahorro real de al menos un 5 % sobre el precio anterior.
 * Sin ninguna, ni la franja ni las diapositivas de oferta aparecen.
 */
const offers = computed(() =>
  pool.value
    .filter((item) => item.compareAtPrice && item.compareAtPrice > item.minPrice)
    .map((item) => ({
      item,
      percent: Math.round(((item.compareAtPrice! - item.minPrice) / item.compareAtPrice!) * 100)
    }))
    .filter((entry) => entry.percent >= 5)
    .sort((left, right) => right.percent - left.percent)
    .slice(0, 12)
    .map((entry) => entry.item)
)

/**
 * Destacados en rejilla (10 en escritorio ancho, 4 en móvil). Si hay pocos marcados como
 * destacados se completa con el catálogo, sin repetir lo que ya está en ofertas: una fila
 * incompleta se lee como un fallo de la página.
 */
const featuredGrid = computed(() => {
  const inOffers = new Set(offers.value.map((item) => item.id))
  const picked = featuredItems.value.filter((item) => !inOffers.has(item.id))
  const seen = new Set([...inOffers, ...picked.map((item) => item.id)])
  // El relleno alterna familias para que la fila no sean ocho variantes del mismo artículo.
  const byCategory = new Map<number, ProductSummary[]>()
  for (const item of pool.value) {
    if (seen.has(item.id) || !item.image) continue
    byCategory.set(item.categoryId, [...(byCategory.get(item.categoryId) ?? []), item])
  }
  const filler: ProductSummary[] = []
  for (let round = 0; filler.length < 10 && round < 10; round++)
    for (const items of byCategory.values()) if (items[round]) filler.push(items[round]!)
  return [...picked, ...filler].slice(0, 10)
})

/**
 * Familias del escaparate: el primer nivel bajo cada raíz, solo con producto, de más a
 * menos surtido. Una familia sin referencias no se enseña: lleva a una página vacía.
 */
const families = computed(() =>
  (catData.value?.roots ?? [])
    .flatMap((root) => (root.children.length ? root.children : [root]))
    .filter((category) => category.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)
)

/**
 * «Compra por familias»: las categorías principales reales con producto, hasta ocho. Si hay
 * menos de ocho principales, la rejilla se completa con sus familias de más surtido para
 * que siempre sean ocho tarjetas (dos filas de cuatro, o cuatro de dos en móvil).
 */
const FAMILY_TILES = 8
const tileCategories = computed(() => {
  const mains = (catData.value?.roots ?? []).filter((root) => root.count > 0).slice(0, FAMILY_TILES)
  const picked = new Set(mains.map((category) => category.id))
  const rest = mains
    .flatMap((root) => root.children)
    .filter((category) => category.count > 0 && !picked.has(category.id))
    .sort((left, right) => right.count - left.count)
  return [...mains, ...rest].slice(0, FAMILY_TILES)
})

/** Fotografía de ambiente que mejor encaja con una categoría sin foto propia, por su nombre. */
const PHOTO_HINTS: Array<[RegExp, string]> = [
  [/reposter|pasteler|molde/, 'reposteria-y-moldes'],
  [/mesa|buffet|servicio|cuberter/, 'mesa-y-servicio'],
  [/corte|cuchill|prepara/, 'corte-y-preparacion'],
  [/termo|botella|sifon|bar|bebida|cafe/, 'termos-botellas-y-sifones'],
  [/coccion|cacerola|cocina profesional|sarten|olla/, 'coccion-y-cacerolas'],
  [/menaje|utensilio|equipamiento|cocina/, 'menaje-de-cocina'],
  [/hosteler/, 'menaje-y-hosteleria'],
  [/guante|protecc|epi/, 'guantes-y-proteccion'],
  [/celulosa|papel|desechable/, 'celulosa-y-desechables'],
  [/quimic|limpieza|higiene/, 'productos-quimicos']
]
function hintedPhoto(name: string, used: Set<string>): HomeImage | null {
  const folded = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  for (const [pattern, slug] of PHOTO_HINTS) {
    const photo = pattern.test(folded) ? familyPhoto(slug) : null
    if (photo && !used.has(photo.src)) return photo
  }
  return null
}

/** Categoría de cada producto → familia del escaparate a la que pertenece. */
const familyOfCategory = computed(() => {
  const flat = catData.value?.flat ?? []
  const parent = new Map(flat.map((category) => [category.id, category.parentId]))
  const familyIds = new Set(families.value.map((family) => family.id))
  const result = new Map<number, number>()
  for (const category of flat) {
    let current: number | null | undefined = category.id
    for (let depth = 0; current != null && depth < 8; depth++) {
      if (familyIds.has(current)) {
        result.set(category.id, current)
        break
      }
      current = parent.get(current)
    }
  }
  return result
})

/** Franjas horizontales: las cuatro familias con más catálogo, doce productos cada una. */
const { data: familyRows } = await useAsyncData('home-family-strips', async () => {
  const picked = families.value.slice(0, 4)
  const results = await Promise.all(
    picked.map((family) =>
      $fetch<ProductListResponse>('/api/products', { params: { category: family.slug, limit: 12 } }).catch(() => null)
    )
  )
  return picked.map((family, index) => ({
    id: family.id,
    name: family.name,
    slug: family.slug,
    count: family.count,
    items: results[index]?.items ?? []
  }))
})

/**
 * Lo que ya se ha enseñado arriba no se repite en las franjas, salvo que la franja se
 * quedara corta: con poco catálogo es mejor repetir una tarjeta que dejar la fila coja.
 */
const familyStrips = computed(() => {
  const shown = new Set(featuredGrid.value.map((item) => item.id))
  return (familyRows.value ?? [])
    .map((row) => {
      const items = (row.items as ProductSummary[]).filter(showable)
      const fresh = items.filter((item) => !shown.has(item.id))
      return { ...row, items: fresh.length >= 4 ? fresh : items }
    })
    .filter((row) => row.items.length >= 2)
})

/** Productos con foto de las categorías del escaparate que no tienen fotografía propia. */
const { data: tileSamples } = await useAsyncData('home-family-tile-samples', async () => {
  const missing = tileCategories.value.filter((category) => !familyPhoto(category.slug))
  const results = await Promise.all(
    missing.map((category) =>
      $fetch<ProductListResponse>('/api/products', { params: { category: category.slug, limit: 12 } }).catch(() => null)
    )
  )
  return missing.map((category, index) => ({
    id: category.id,
    items: (results[index]?.items ?? []).filter((item) => item.image)
  }))
})

/**
 * Tarjetas de familia, cada una con una imagen distinta: su fotografía propia; si no la
 * tiene, la de ambiente que encaja con su nombre; y si tampoco, la foto de un producto real
 * de la familia. Ninguna imagen se repite entre tarjetas.
 */
const familyTiles = computed<HomeFamilyTile[]>(() => {
  const used = new Set<string>()
  // Las fotografías propias se reservan primero para que ninguna reserva se las quite.
  for (const category of tileCategories.value) {
    const own = familyPhoto(category.slug)
    if (own) used.add(own.src)
  }
  return tileCategories.value.map((category) => {
    const base = { id: category.id, name: category.name, slug: category.slug, count: category.count }
    const own = familyPhoto(category.slug)
    if (own) return { ...base, photo: own, sample: null }
    const hinted = hintedPhoto(category.name, used)
    if (hinted) {
      used.add(hinted.src)
      return { ...base, photo: hinted, sample: null }
    }
    const candidates = [
      ...(tileSamples.value?.find((row) => row.id === category.id)?.items ?? []),
      ...pool.value.filter((item) => item.image && familyOfCategory.value.get(item.categoryId) === category.id)
    ]
    const sample = candidates.find((item) => item.image && !used.has(item.image)) ?? null
    if (sample?.image) used.add(sample.image)
    return { ...base, photo: null, sample }
  })
})

const { promises, terms: commercialTerms } = useCommercialTerms()

/**
 * Quien vuelve con sesión y pedidos ve primero su recompra; el carrusel sigue debajo con
 * el titular en h2. Se decide en cliente: esta página se sirve desde una caché compartida
 * y no puede llevar datos de ninguna cuenta.
 */
const { lastOrder } = await useLastOrder()
const returning = computed(() => !!lastOrder.value)

const ecoRangeAvailable = computed(() =>
  (catData.value?.flat ?? []).some((category) => category.slug === 'linea-eco-profesional' && category.count > 0)
)

const orderSamples = computed<ProductCardData[]>(() => featuredGrid.value)
</script>

<template>
  <div>
    <ClientOnly><HomeReorder v-if="returning" /></ClientOnly>

    <HomeHeroCarousel :offers="offers" :featured="featuredItems" :heading="returning ? 'h2' : 'h1'" />

    <!-- Garantías en una línea, bajo el carrusel: lo primero que decide quien compra para un negocio -->
    <div class="border-b border-[var(--border)] bg-[var(--surface)]">
      <ul
        class="scrollbar-none mx-auto flex max-w-[1600px] snap-x gap-6 overflow-x-auto px-4 py-3 sm:px-6 lg:justify-between"
        aria-label="Condiciones de compra"
      >
        <li
          v-for="promise in promises"
          :key="promise.key"
          class="max-w-[280px] shrink-0 snap-start lg:max-w-none lg:shrink"
        >
          <NuxtLink :to="promise.to" class="group flex items-center gap-2.5 py-1">
            <UIcon :name="promise.icon" class="size-5 shrink-0 text-neteco-700" aria-hidden="true" />
            <span class="min-w-0 text-sm leading-snug">
              <span class="font-semibold text-[var(--text-strong)] group-hover:text-[var(--link)]">{{
                promise.title
              }}</span>
              <span class="line-clamp-1 text-[var(--text-muted)]">{{ promise.text }}</span>
            </span>
          </NuxtLink>
        </li>
      </ul>
    </div>

    <PromotionalBlocks :context="{ placement: 'home', path: '/' }" class="mx-auto max-w-[1600px] px-4 pt-6 sm:px-6" />

    <HomeFamilyTiles :families="familyTiles" />

    <HomeProductStrip
      v-if="offers.length"
      id="ofertas"
      title="Precios rebajados esta semana"
      :items="offers"
      to="/catalogo"
      link-label="Ver el catálogo"
    />

    <!-- destacados -->
    <section
      v-if="featuredGrid.length"
      aria-labelledby="home-featured"
      class="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8"
    >
      <h2 id="home-featured" class="mb-4 text-xl font-bold text-[var(--text-strong)] sm:text-2xl">
        Productos destacados
      </h2>
      <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
        <li
          v-for="(product, position) in featuredGrid"
          :key="product.id"
          class="flex [&>*]:w-full"
          :class="
            position >= 8 ? 'hidden xl:flex' : position >= 6 ? 'hidden lg:flex' : position >= 4 ? 'hidden sm:flex' : ''
          "
        >
          <ProductCard :product="product" />
        </li>
      </ul>
    </section>

    <HomeProductStrip
      v-for="row in familyStrips.slice(0, 2)"
      :key="row.slug"
      :title="row.name"
      :items="row.items"
      :to="`/categoria/${row.slug}`"
      :link-label="`Ver los ${row.count}`"
    />

    <HomeOrderWays :samples="orderSamples" />

    <HomeProductStrip
      v-for="row in familyStrips.slice(2)"
      :key="row.slug"
      :title="row.name"
      :items="row.items"
      :to="`/categoria/${row.slug}`"
      :link-label="`Ver los ${row.count}`"
    />

    <HomeTrustBand />

    <!-- línea eco: acento verde sobre una superficie del sistema, no un anuncio a sangre -->
    <section v-if="ecoRangeAvailable" class="mx-auto max-w-[1600px] px-4 pb-10 sm:px-6">
      <NuxtLink
        to="/categoria/linea-eco-profesional"
        class="group flex flex-col justify-between gap-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 transition-colors hover:border-[var(--border-strong)] sm:flex-row sm:items-center sm:p-8"
      >
        <div>
          <p class="flex items-center gap-2 text-sm font-semibold text-[var(--text-muted)]">
            <UIcon name="i-lucide-leaf" class="size-4 text-green-800" /> Línea eco-profesional
          </p>
          <h2 class="mt-1.5 text-2xl font-bold text-[var(--text-strong)]">
            Limpieza profesional, respeto por el entorno
          </h2>
          <p class="mt-1 text-[var(--text)]">
            <template v-if="commercialTerms.ecoRangeBrand"
              >La gama ecológica {{ commercialTerms.ecoRangeBrand }}. </template
            >Productos de limpieza profesional con menor impacto ambiental.
          </p>
        </div>
        <span
          class="inline-flex h-11 shrink-0 items-center gap-2 self-start rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-5 font-semibold text-[var(--text-strong)] transition group-hover:gap-3 sm:self-auto"
        >
          Ver la línea eco <UIcon name="i-lucide-arrow-right" class="size-4" />
        </span>
      </NuxtLink>
    </section>
  </div>
</template>
