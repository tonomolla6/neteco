<script setup lang="ts">
import type { CategoryResponse, ProductListResponse } from '~~/shared/types/catalog'

useSeoMeta({
  title: 'Suministros profesionales de limpieza e higiene',
  description:
    'Tienda online de NETECO: químicos de limpieza, higiene y menaje profesional para hostelería, comercio, industria y colectividades. Reparto propio en Ontinyent y comarca.'
})

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
const { data: featured } = await useFetch<ProductListResponse>('/api/products', {
  key: 'featured',
  params: { featured: 1, limit: 4 }
})

const families = computed(() => {
  const roots = catData.value?.roots ?? []
  const all = roots.flatMap((root) => root.children)
  return all
    .filter((category) => category.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 8)
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

// enlazan solo a familias con producto; se remapearán según crezca el catálogo
const sectors = [
  {
    name: 'Hostelería',
    desc: 'Limpieza de cocina y sala',
    icon: 'i-lucide-utensils-crossed',
    to: '/categoria/limpiadores-generales'
  },
  {
    name: 'Comercio',
    desc: 'Limpieza sostenible del local',
    icon: 'i-lucide-store',
    to: '/categoria/linea-eco-profesional'
  },
  {
    name: 'Industria',
    desc: 'Maquinaria y fregadoras',
    icon: 'i-lucide-factory',
    to: '/categoria/limpiadores-maquina'
  },
  {
    name: 'Colectividades',
    desc: 'Guantes y protección',
    icon: 'i-lucide-building-2',
    to: '/categoria/guantes-y-proteccion'
  }
]
</script>

<template>
  <div>
    <!-- hero -->
    <section class="relative overflow-hidden bg-gradient-to-b from-neteco-950 via-neteco-900 to-neteco-700 text-white">
      <div
        class="mx-auto grid max-w-[1600px] items-center gap-12 px-4 py-14 sm:py-16 lg:grid-cols-[1fr_480px] lg:py-20"
      >
        <div class="max-w-2xl">
          <p class="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium">
            <UIcon name="i-lucide-badge-check" class="size-4" /> Más de 25 años al servicio de tu negocio
          </p>
          <h1 class="text-3xl font-bold leading-tight sm:text-5xl">
            Todo lo que tu negocio necesita, <span class="text-neteco-300">en un solo pedido</span>
          </h1>
          <p class="mt-4 text-lg text-neteco-100">
            Químicos de limpieza profesional, higiene y menaje para hostelería, comercio, industria y colectividades.
            Con reparto propio en Ontinyent y la Vall d'Albaida.
          </p>
          <div class="mt-8 hidden max-w-xl md:block">
            <SearchBox size="xl" placeholder="¿Qué necesita tu negocio?" />
          </div>
          <div class="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-neteco-100">
            <span class="flex items-center gap-1.5"
              ><UIcon name="i-lucide-truck" class="size-4" /> Logística propia</span
            >
            <span class="flex items-center gap-1.5"
              ><UIcon name="i-lucide-messages-square" class="size-4" /> Trato de tú a tú</span
            >
            <span class="flex items-center gap-1.5"
              ><UIcon name="i-lucide-shield-check" class="size-4" /> Marcas profesionales</span
            >
          </div>
        </div>

        <!-- la estantería: envases del catálogo, con el color de cada familia -->
        <div class="hidden lg:block" aria-hidden="true">
          <div class="flex items-end justify-center gap-2">
            <div
              class="w-24 shrink-0 -rotate-3 rounded-xl bg-white p-1.5 shadow-xl shadow-neteco-950/40 transition hover:-translate-y-1"
            >
              <ProductVisual :visual="{ type: 'garrafa', color: '#f97316' }" />
            </div>
            <div
              class="w-20 shrink-0 rotate-2 rounded-xl bg-white p-1.5 shadow-xl shadow-neteco-950/40 transition hover:-translate-y-1"
            >
              <ProductVisual :visual="{ type: 'spray', color: '#16a34a' }" />
            </div>
            <div
              class="w-28 shrink-0 -rotate-1 rounded-xl bg-white p-1.5 shadow-xl shadow-neteco-950/40 transition hover:-translate-y-2"
            >
              <ProductVisual :visual="{ type: 'caja', color: '#009ac9' }" />
            </div>
            <div
              class="w-20 shrink-0 rotate-3 rounded-xl bg-white p-1.5 shadow-xl shadow-neteco-950/40 transition hover:-translate-y-1"
            >
              <ProductVisual :visual="{ type: 'botella', color: '#7c3aed' }" />
            </div>
            <div
              class="w-24 shrink-0 -rotate-2 rounded-xl bg-white p-1.5 shadow-xl shadow-neteco-950/40 transition hover:-translate-y-1"
            >
              <ProductVisual :visual="{ type: 'capsulas', color: '#0891b2' }" />
            </div>
          </div>
          <div class="mx-2 mt-3 h-3 rounded-sm bg-gradient-to-b from-neteco-950/80 to-neteco-950/40" />
          <p class="mt-4 text-center text-sm text-neteco-200">Cada familia, con su color. Como en tu almacén.</p>
        </div>
      </div>
    </section>

    <!-- sectores -->
    <section class="mx-auto max-w-[1600px] px-4 py-12">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NuxtLink
          v-for="s in sectors"
          :key="s.name"
          :to="s.to"
          class="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-md"
        >
          <span
            class="rounded-xl bg-neteco-50 p-3 text-neteco-600 transition group-hover:bg-neteco-500 group-hover:text-white"
          >
            <UIcon :name="s.icon" class="block size-6" />
          </span>
          <span>
            <span class="block font-semibold text-slate-800">{{ s.name }}</span>
            <span class="block text-sm text-slate-500">{{ s.desc }}</span>
          </span>
        </NuxtLink>
      </div>
    </section>

    <!-- familias -->
    <section class="mx-auto max-w-[1600px] px-4 py-4">
      <div class="mb-5 flex items-end justify-between">
        <div>
          <p class="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
            <span class="size-2 rounded-full bg-neteco-500" /> Catálogo
          </p>
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
          class="group rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-md"
        >
          <p class="flex items-start gap-2 font-medium leading-snug text-slate-800 group-hover:text-neteco-700">
            <span
              class="mt-1.5 size-2.5 shrink-0 rounded-full"
              :style="{ background: familyColor(f.slug) }"
              aria-hidden="true"
            />
            {{ f.name }}
          </p>
          <p class="mt-1 pl-[18px] text-xs text-slate-500">{{ f.count }} producto{{ f.count === 1 ? '' : 's' }}</p>
        </NuxtLink>
      </div>
    </section>

    <!-- destacados -->
    <section v-if="featured?.items.length" class="mx-auto max-w-[1600px] px-4 py-12">
      <div class="mb-5">
        <p class="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
          <span class="size-2 rounded-full bg-amber-400" /> Los más pedidos
        </p>
        <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Productos destacados</h2>
      </div>
      <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ProductCard v-for="p in featured?.items ?? []" :key="p.id" :product="p" />
      </div>
    </section>

    <!-- filas por familia -->
    <section v-for="row in familyRows ?? []" :key="row.slug" class="mx-auto max-w-[1600px] px-4 pb-12">
      <div class="mb-5 flex items-end justify-between gap-3">
        <div>
          <p class="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
            <span class="size-2 rounded-full" :style="{ background: familyColor(row.slug) }" /> Familia
          </p>
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
    <section class="mx-auto max-w-[1600px] px-4 pb-12">
      <NuxtLink
        to="/categoria/linea-eco-profesional"
        class="group flex flex-col justify-between gap-4 rounded-2xl bg-gradient-to-r from-emerald-700 to-emerald-500 p-8 text-white sm:flex-row sm:items-center"
      >
        <div>
          <p class="flex items-center gap-2 text-sm font-medium text-emerald-100">
            <UIcon name="i-lucide-leaf" class="size-4" /> Línea eco-profesional
          </p>
          <h2 class="mt-1 text-2xl font-bold">Limpieza profesional, respeto por el entorno</h2>
          <p class="mt-1 text-emerald-100">La gama ecológica de NETTION: misma eficacia, menos impacto.</p>
        </div>
        <span
          class="inline-flex items-center gap-2 self-start rounded-full bg-white px-5 py-2.5 font-semibold text-emerald-700 transition group-hover:gap-3 sm:self-auto"
        >
          Ver la línea eco <UIcon name="i-lucide-arrow-right" class="size-4" />
        </span>
      </NuxtLink>
    </section>

    <!-- confianza -->
    <section class="border-t border-slate-200 bg-white">
      <div class="mx-auto max-w-[1600px] px-4 pt-12">
        <p class="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
          <span class="size-2 rounded-full bg-neteco-500" /> Por qué NETECO
        </p>
        <h2 class="text-xl font-bold text-slate-900 sm:text-2xl">Un proveedor, cero complicaciones</h2>
      </div>
      <div class="mx-auto grid max-w-[1600px] gap-8 px-4 py-10 md:grid-cols-3">
        <div class="flex gap-4">
          <span class="h-fit rounded-xl bg-neteco-50 p-3 text-neteco-600"
            ><UIcon name="i-lucide-truck" class="block size-6"
          /></span>
          <div>
            <h3 class="font-semibold text-slate-900">Logística propia</h3>
            <p class="mt-1 text-sm text-slate-500">
              Repartimos nosotros mismos en Ontinyent y alrededores para asegurar que te llegue bien y a tiempo.
            </p>
          </div>
        </div>
        <div class="flex gap-4">
          <span class="h-fit rounded-xl bg-neteco-50 p-3 text-neteco-600"
            ><UIcon name="i-lucide-messages-square" class="block size-6"
          /></span>
          <div>
            <h3 class="font-semibold text-slate-900">Trato de tú a tú</h3>
            <p class="mt-1 text-sm text-slate-500">
              Sin centralitas ni robots: hablas con personas que conocen tu negocio y saben lo que necesitas.
            </p>
          </div>
        </div>
        <div class="flex gap-4">
          <span class="h-fit rounded-xl bg-neteco-50 p-3 text-neteco-600"
            ><UIcon name="i-lucide-shield-check" class="block size-6"
          /></span>
          <div>
            <h3 class="font-semibold text-slate-900">Garantía profesional</h3>
            <p class="mt-1 text-sm text-slate-500">
              Marcas líderes como NETTION: productos concentrados de alto rendimiento que no encuentras en el súper.
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
