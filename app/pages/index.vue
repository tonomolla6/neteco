<script setup lang="ts">
import type { CategoryResponse, ProductListResponse } from '~~/shared/types/catalog'
import PromotionalBlocks from '~/components/PromotionalBlocks.vue'

const governedMedia = useRuntimeConfig().public.mediaGoverned

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
  params: { featured: 1, limit: 4 }
})

/**
 * Ofertas.
 *
 * La home no tenía ninguna. Todos los mayoristas del sector con los que se comparó
 * —Shalbaida, Muñoz Bosch, Plasticosur— abren con una oferta visible y su ahorro: es lo
 * primero que mira un hostelero que compra lo mismo cada mes y decide por precio.
 *
 * Se muestran solo las que tienen un ahorro real sobre el precio anterior. Si no hay
 * ninguna, la sección no aparece: una fila de «ofertas» sin descuento es peor que no
 * tenerla.
 */
const { data: offersData } = await useFetch<ProductListResponse>('/api/products', {
  key: 'home-offers',
  params: { limit: 24 }
})
const offers = computed(() =>
  (offersData.value?.items ?? [])
    .filter((item) => item.compareAtPrice && item.compareAtPrice > item.minPrice)
    .map((item) => ({
      item,
      percent: Math.round(((item.compareAtPrice! - item.minPrice) / item.compareAtPrice!) * 100)
    }))
    .filter((entry) => entry.percent >= 5)
    .sort((left, right) => right.percent - left.percent)
    .slice(0, 4)
    .map((entry) => entry.item)
)

/**
 * Relleno de la fila de destacados.
 *
 * Solo hay un producto marcado como destacado, así que la rejilla de cuatro columnas
 * quedaba con tres huecos blancos. Una fila incompleta se lee como un error de la página,
 * no como «hay poco destacado», así que se completa con el resto del catálogo sin repetir.
 */
const { data: fallback } = await useFetch<ProductListResponse>('/api/products', {
  key: 'home-fallback',
  params: { limit: 8 }
})
const featuredRow = computed(() => {
  // Sin excluir las ofertas, con este catálogo los «destacados» repetían dos de las cuatro
  // tarjetas de la fila anterior, y dos bloques casi idénticos seguidos se leen como un fallo.
  const inOffers = new Set(offers.value.map((item) => item.id))
  const picked = (featured.value?.items ?? []).filter((item) => !inOffers.has(item.id))
  if (picked.length >= 4) return picked.slice(0, 4)
  const seen = new Set([...inOffers, ...picked.map((item) => item.id)])
  const filler = (fallback.value?.items ?? []).filter((item) => !seen.has(item.id))
  return [...picked, ...filler].slice(0, 4)
})

/**
 * Familias del escaparate.
 *
 * Antes se filtraba por `count > 0` sobre las familias de segundo nivel. Con el catálogo
 * cargado hoy —los 20 productos viven todos en dos hojas de tercer nivel— eso dejaba **una
 * sola tarjeta** en una rejilla de cuatro columnas: un visitante nuevo concluía que NETECO
 * vende guantes.
 *
 * El escaparate de un mayorista tiene que comunicar amplitud, así que ahora se muestran las
 * familias con producto primero y se completa la rejilla con el resto del árbol, para que se
 * vea el surtido real. Las que aún no tienen referencias cargadas se marcan como tales en
 * lugar de esconderse: prometen menos y no llevan a un callejón sin salida silencioso.
 */
const families = computed(() => {
  const roots = catData.value?.roots ?? []
  const all = roots.flatMap((root) => root.children)
  const withStock = all.filter((category) => category.count > 0).sort((left, right) => right.count - left.count)
  const rest = all.filter((category) => category.count === 0)
  return [...withStock, ...rest].slice(0, 8)
})

// filas de producto por familia (las 3 con más catálogo), estilo mayorista
const { data: familyRows } = await useAsyncData('home-family-rows', async () => {
  const fams = families.value.slice(0, 3)
  const results = await Promise.all(
    fams.map((family) =>
      $fetch<ProductListResponse>('/api/products', { params: { category: family.slug, limit: 4 } }).catch(() => null)
    )
  )
  return fams
    .map((family, index) => ({
      name: family.name,
      slug: family.slug,
      count: family.count,
      items: results[index]?.items ?? []
    }))
    .filter((row) => row.items.length)
})

/**
 * Con una sola familia con stock, la fila de familia repetía exactamente los mismos cuatro
 * productos que los destacados de arriba: dos bloques idénticos seguidos, que se leen como
 * un fallo de la página. Se ocultan las filas cuyo contenido ya se ha enseñado.
 */
const visibleFamilyRows = computed(() => {
  const shown = new Set([...offers.value, ...featuredRow.value].map((item) => item.id))
  return (familyRows.value ?? [])
    .map((row) => ({ ...row, items: row.items.filter((item) => !shown.has(item.id)) }))
    .filter((row) => row.items.length)
})

/**
 * Garantías bajo el hero. Salen de las condiciones comerciales configuradas: cada una
 * afirma un hecho y, si el negocio no ha fijado el dato, no se publica.
 */
const { promises, terms: commercialTerms } = useCommercialTerms()

// enlazan solo a familias con producto; se remapearán según crezca el catálogo
const sectors = [
  {
    name: 'Hostelería',
    desc: 'Limpieza de cocina y sala',
    image: SECTOR_IMAGES.hosteleria,
    to: '/categoria/limpiadores-generales'
  },
  {
    name: 'Comercio',
    desc: 'Limpieza sostenible del local',
    image: SECTOR_IMAGES.comercio,
    to: '/categoria/linea-eco-profesional'
  },
  {
    name: 'Industria',
    desc: 'Maquinaria y fregadoras',
    image: SECTOR_IMAGES.industria,
    to: '/categoria/limpiadores-maquina'
  },
  {
    name: 'Colectividades',
    desc: 'Guantes y protección',
    image: SECTOR_IMAGES.colectividades,
    to: '/categoria/guantes-y-proteccion'
  }
]
</script>

<template>
  <div>
    <!-- hero -->
    <section class="relative overflow-hidden bg-gradient-to-b from-neteco-950 via-neteco-900 to-neteco-700 text-white">
      <!-- Hero partido: el mensaje sobre el azul de marca y la oferta sobre un panel claro
           que llega al borde. Las fotos de producto vienen con fondo blanco de estudio, así
           que sobre el degradado siempre se leerían como una tarjeta pegada; con el panel,
           el blanco es parte de la composición y no un recorte. -->
      <div
        class="mx-auto grid max-w-[1600px] grid-cols-1 items-stretch"
        :class="offers.length ? 'lg:grid-cols-[1fr_460px]' : ''"
      >
        <div class="max-w-2xl px-4 py-14 sm:py-16 lg:py-20">
          <p class="mb-3 text-sm font-medium text-neteco-200">Más de 25 años al servicio de tu negocio</p>
          <!-- `text-white` explícito: la regla global de titulares fija `--text-strong`, y una
               regla de elemento gana siempre al color heredado del contenedor oscuro. -->
          <h1 class="text-3xl font-bold leading-tight text-white sm:text-5xl">
            Todo lo que tu negocio necesita, <span class="text-neteco-300">en un solo pedido</span>
          </h1>
          <p class="mt-4 text-lg text-neteco-100">
            Químicos de limpieza profesional, higiene y menaje para hostelería, comercio, industria y colectividades.
            Con reparto propio en Ontinyent y la Vall d'Albaida.
          </p>
          <div class="mt-8 hidden max-w-xl md:block">
            <SearchBox size="xl" placeholder="Busca por producto o referencia del albarán" />
          </div>

          <!-- Dos caminos, no tres: ver el catálogo o pedir por teléfono, que en este sector
               sigue siendo como entra la mitad de los pedidos. -->
          <div class="mt-6 flex flex-wrap items-center gap-3">
            <NuxtLink
              to="/catalogo"
              class="inline-flex items-center gap-2 rounded-[var(--radius-control)] bg-white px-6 py-3 font-semibold text-neteco-900 transition hover:bg-neteco-50"
            >
              Ver el catálogo
              <UIcon name="i-lucide-arrow-right" class="size-4" />
            </NuxtLink>
            <a
              href="tel:600861334"
              class="inline-flex items-center gap-2 rounded-[var(--radius-control)] border border-white/40 px-6 py-3 font-semibold text-white transition hover:bg-white/10"
            >
              <UIcon name="i-lucide-phone" class="size-4" />
              600 861 334
            </a>
          </div>
        </div>

        <!-- Ofertas en el hueco más caro de la página. Antes había una ilustración
             decorativa de envases con el pie «Cada familia, con su color. Como en tu
             almacén.»: bonita, pero no llevaba a ningún sitio ni vendía nada. -->
        <div v-if="offers.length" class="hidden bg-white px-8 py-10 lg:flex lg:flex-col lg:justify-center">
          <HeroOfferSlider :items="offers" />
        </div>
      </div>
    </section>

    <PromotionalBlocks :context="{ placement: 'home', path: '/' }" class="mx-auto max-w-[1600px] px-4 py-5" />

    <!-- promesas: la barra que todos los mayoristas del sector ponen bajo el hero, porque
         es lo que decide un hostelero antes de mirar un solo producto -->
    <section class="border-b border-[var(--border)] bg-[var(--surface)]">
      <div
        data-commercial-promises
        class="mx-auto grid max-w-[1600px] gap-4 px-4 py-5 grid-cols-1 sm:grid-cols-2"
        :class="promises.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'"
      >
        <NuxtLink
          v-for="promise in promises"
          :key="promise.key"
          :to="promise.to"
          class="flex items-start gap-3 rounded focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <UIcon :name="promise.icon" class="mt-0.5 size-5 shrink-0 text-[var(--text-muted)]" />
          <div class="min-w-0">
            <p class="text-sm font-semibold text-[var(--text-strong)]">{{ promise.title }}</p>
            <p class="text-sm text-[var(--text-muted)]">{{ promise.text }}</p>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- ofertas -->
    <section v-if="offers.length" class="mx-auto max-w-[1600px] px-4 pt-12">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Precios rebajados esta semana</h2>
        </div>
        <NuxtLink to="/catalogo" class="text-sm font-medium text-neteco-600 hover:text-neteco-500">
          Ver todo el catálogo →
        </NuxtLink>
      </div>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in offers" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- sectores: es el bloque más fuerte de la competencia («Tu negocio»), porque el
         comprador no busca «desengrasante», busca «lo que necesito para mi bar» -->
    <section class="mx-auto max-w-[1600px] px-4 py-12">
      <div class="mb-5">
        <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Empieza por tu sector</h2>
      </div>
      <div class="grid gap-3 grid-cols-2 sm:gap-4 lg:grid-cols-4">
        <NuxtLink
          v-for="s in sectors"
          :key="s.name"
          :to="s.to"
          class="group overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] transition hover:border-neteco-300 hover:shadow-md"
        >
          <div class="flex h-28 items-center sm:h-40 justify-center overflow-hidden bg-[var(--canvas)]">
            <img
              v-if="!governedMedia"
              :src="s.image"
              alt=""
              width="240"
              height="160"
              loading="lazy"
              class="h-full w-full object-contain p-3 transition duration-300 group-hover:scale-105"
            />
            <UIcon v-else name="i-lucide-package" class="size-16 text-neteco-600" aria-hidden="true" />
          </div>
          <div class="p-3 sm:p-5">
            <p class="text-base font-bold sm:text-lg text-[var(--text-strong)] group-hover:text-neteco-700">
              {{ s.name }}
            </p>
            <p class="mt-1 text-sm text-[var(--text-muted)]">{{ s.desc }}</p>
            <p class="mt-3 flex items-center gap-1 text-sm font-medium text-neteco-700">
              Ver productos <UIcon name="i-lucide-arrow-right" class="size-4 transition group-hover:translate-x-0.5" />
            </p>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- familias -->
    <section class="mx-auto max-w-[1600px] px-4 py-4">
      <div class="mb-5 flex items-end justify-between">
        <div>
          <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Compra por familia</h2>
        </div>
        <NuxtLink to="/catalogo" class="text-sm font-medium text-neteco-600 hover:text-neteco-500">
          Ver todo el catálogo →
        </NuxtLink>
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <NuxtLink
          v-for="f in families"
          :key="f.id"
          :to="`/categoria/${f.slug}`"
          class="group flex min-w-0 flex-col gap-2 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-3 transition hover:border-neteco-300 hover:shadow-md sm:flex-row sm:items-center sm:gap-3"
        >
          <!-- En horizontal a 390 px la columna de texto quedaba en 71 px y los nombres de
               familia se rompían por la mitad. Apilado, el texto ocupa el ancho de la tarjeta. -->
          <div
            class="flex h-20 w-full shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-surface)] bg-[var(--canvas)] sm:size-16"
          >
            <img
              v-if="!governedMedia"
              :src="familyImage(f.slug)"
              alt=""
              width="64"
              height="64"
              loading="lazy"
              class="h-full w-full object-contain p-1 transition duration-300 group-hover:scale-105"
            />
            <UIcon v-else name="i-lucide-package" class="size-8 text-neteco-600" aria-hidden="true" />
          </div>
          <div class="min-w-0">
            <p class="text-sm font-medium leading-snug text-[var(--text-strong)] group-hover:text-neteco-700">
              {{ f.name }}
            </p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">
              <template v-if="f.count">{{ f.count }} producto{{ f.count === 1 ? '' : 's' }}</template>
              <template v-else>Consúltanos disponibilidad</template>
            </p>
          </div>
        </NuxtLink>
      </div>
    </section>

    <!-- destacados -->
    <section v-if="featuredRow.length" class="mx-auto max-w-[1600px] px-4 py-12">
      <div class="mb-5">
        <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Productos destacados</h2>
      </div>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in featuredRow" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- filas por familia -->
    <section v-for="row in visibleFamilyRows" :key="row.slug" class="mx-auto max-w-[1600px] px-4 pb-12">
      <div class="mb-5 flex items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">{{ row.name }}</h2>
        </div>
        <NuxtLink
          :to="`/categoria/${row.slug}`"
          class="shrink-0 text-sm font-medium text-neteco-600 hover:text-neteco-500"
        >
          Ver los {{ row.count }} →
        </NuxtLink>
      </div>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in row.items" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- banner línea eco -->
    <!-- Era un degradado verde saturado a sangre, el único elemento de la página con ese
         tratamiento: leía como un anuncio de terceros incrustado y competía con el azul de
         marca por la atención. El verde se queda —es lo que significa «eco»— pero como
         acento sobre una superficie del sistema, no como fondo. -->
    <section class="mx-auto max-w-[1600px] px-4 pb-12">
      <NuxtLink
        to="/categoria/linea-eco-profesional"
        class="group flex flex-col justify-between gap-4 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 transition-colors hover:border-neteco-300 sm:flex-row sm:items-center sm:p-8"
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
          class="inline-flex shrink-0 items-center gap-2 self-start rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-5 py-2.5 font-semibold text-[var(--text-strong)] transition group-hover:gap-3 sm:self-auto"
        >
          Ver la línea eco <UIcon name="i-lucide-arrow-right" class="size-4" />
        </span>
      </NuxtLink>
    </section>

    <!-- cómo pedir: en suministro profesional el pedido entra tanto por la web como por
         teléfono o WhatsApp. Esconder esas vías no las elimina, solo las hace más lentas. -->
    <section class="mx-auto max-w-[1600px] px-4 pb-12">
      <div class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8">
        <div class="mb-6">
          <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Como te venga mejor</h2>
        </div>
        <div class="grid gap-6 grid-cols-1 md:grid-cols-3">
          <div>
            <UIcon name="i-lucide-rotate-cw" class="size-6 text-neteco-700" />
            <h3 class="mt-3 font-semibold text-[var(--text-strong)]">Repite tu último pedido</h3>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Con tu cuenta, vuelves a pedir lo mismo en dos clics. Sin buscar referencia por referencia.
            </p>
            <UButton class="mt-3" size="sm" color="neutral" variant="outline" to="/cuenta/pedidos">
              Ir a mis pedidos
            </UButton>
          </div>
          <div>
            <UIcon name="i-lucide-search" class="size-6 text-neteco-700" />
            <h3 class="mt-3 font-semibold text-[var(--text-strong)]">Busca por referencia</h3>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Si tienes el albarán delante, escribe el código del artículo y lo encuentras directo.
            </p>
            <UButton class="mt-3" size="sm" color="neutral" variant="outline" to="/catalogo">Ver el catálogo</UButton>
          </div>
          <div>
            <UIcon name="i-lucide-phone" class="size-6 text-neteco-700" />
            <h3 class="mt-3 font-semibold text-[var(--text-strong)]">Llámanos y te lo preparamos</h3>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              De lunes a viernes. Te asesoramos con el producto y la dosificación si hace falta.
            </p>
            <UButton class="mt-3" size="sm" to="tel:600861334" icon="i-lucide-phone">600 861 334</UButton>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
