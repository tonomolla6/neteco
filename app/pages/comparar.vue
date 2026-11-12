<script setup lang="ts">
import type { ProductCompareResponse } from '~~/workers/catalog/product-compare'

const COMPARE_STORAGE_KEY = 'neteco_compare_slugs'
const route = useRoute()
const router = useRouter()

const localSlugs = ref<string[]>([])
const isClient = ref(false)

function readStoredSlugs(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(COMPARE_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.length > 0) : []
  } catch {
    return []
  }
}

function writeStoredSlugs(slugs: string[]) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(slugs))
      window.dispatchEvent(new Event('neteco_compare_updated'))
    }
  } catch {
    // Quota or access error handling
  }
}

onMounted(() => {
  isClient.value = true
  const querySlugs = typeof route.query.slugs === 'string' ? route.query.slugs.split(',').filter(Boolean) : []
  if (querySlugs.length > 0) {
    localSlugs.value = querySlugs.slice(0, 4)
    writeStoredSlugs(localSlugs.value)
  } else {
    localSlugs.value = readStoredSlugs().slice(0, 4)
    if (localSlugs.value.length > 0) {
      router.replace({ query: { slugs: localSlugs.value.join(',') } })
    }
  }

  window.addEventListener('neteco_compare_updated', () => {
    localSlugs.value = readStoredSlugs().slice(0, 4)
  })
})

const activeSlugs = computed(() => {
  if (typeof route.query.slugs === 'string' && route.query.slugs.trim().length > 0) {
    return route.query.slugs
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4)
  }
  return localSlugs.value.slice(0, 4)
})

const slugsQuery = computed(() => activeSlugs.value.join(','))
const canCompare = computed(() => activeSlugs.value.length >= 2 && activeSlugs.value.length <= 4)

const {
  data: comparison,
  status,
  error,
  refresh
} = await useFetch<ProductCompareResponse>(() => `/api/products/compare?slugs=${slugsQuery.value}`, {
  immediate: canCompare.value,
  watch: [slugsQuery]
})

function handleRemove(slugToRemove: string) {
  const updated = activeSlugs.value.filter((s) => s !== slugToRemove)
  writeStoredSlugs(updated)
  localSlugs.value = updated
  router.replace({ query: updated.length > 0 ? { slugs: updated.join(',') } : {} })
}

function clearAll() {
  writeStoredSlugs([])
  localSlugs.value = []
  router.replace({ query: {} })
}

useSeoMeta({
  title: 'Comparador técnico de productos',
  description:
    'Compara especificaciones técnicas, precios, disponibilidad y datos de seguridad de productos químicos y de limpieza profesional.',
  robots: 'noindex, follow'
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <!-- Breadcrumb -->
    <nav class="mb-4 hidden text-xs text-slate-500 md:flex" aria-label="Miga de pan">
      <ol class="inline-flex items-center gap-1.5">
        <li>
          <NuxtLink to="/" class="hover:text-neteco-600">Inicio</NuxtLink>
        </li>
        <li>
          <UIcon name="i-lucide-chevron-right" class="size-3 text-slate-400" />
        </li>
        <li class="font-medium text-slate-800" aria-current="page">Comparador de productos</li>
      </ol>
    </nav>

    <!-- Encabezado de página -->
    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          Comparativa técnica y visual
        </h1>
        <p class="mt-1 text-sm text-slate-600">
          Compara atributos normalizados, formatos y seguridad técnica de hasta 4 productos a la vez.
        </p>
      </div>

      <div v-if="activeSlugs.length > 0" class="flex items-center gap-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 hover:text-red-700"
          @click="clearAll"
        >
          <UIcon name="i-lucide-trash-2" class="size-3.5" />
          <span>Vaciar comparador</span>
        </button>
      </div>
    </div>

    <!-- Estado: Menos de 2 productos -->
    <div
      v-if="!canCompare"
      class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/50 p-12 text-center"
    >
      <div class="rounded-full bg-neteco-50 p-4 text-neteco-600">
        <UIcon name="i-lucide-columns-2" class="size-8" />
      </div>

      <h2 class="mt-4 text-lg font-bold text-slate-900">
        {{ activeSlugs.length === 1 ? 'Añade al menos un producto más' : 'El comparador está vacío' }}
      </h2>

      <p class="mt-1 max-w-md text-sm text-slate-600">
        {{
          activeSlugs.length === 1
            ? 'Has seleccionado 1 producto. Necesitas al menos 2 productos (y un máximo de 4) para realizar una comparación detallada.'
            : 'Selecciona entre 2 y 4 productos desde nuestro catálogo usando el botón «Comparar» de cada producto.'
        }}
      </p>

      <!-- Chips de productos actualmente seleccionados -->
      <div v-if="activeSlugs.length === 1" class="mt-4 flex items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pl-3 pr-2 text-xs font-semibold text-slate-800 shadow-sm"
        >
          <span>{{ activeSlugs[0] }}</span>
          <button
            type="button"
            class="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
            :aria-label="`Quitar ${activeSlugs[0]}`"
            @click="handleRemove(activeSlugs[0]!)"
          >
            <UIcon name="i-lucide-x" class="size-3" />
          </button>
        </span>
      </div>

      <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
        <NuxtLink
          to="/"
          class="inline-flex items-center gap-2 rounded-xl bg-neteco-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-neteco-700"
        >
          <UIcon name="i-lucide-store" class="size-4" />
          <span>Explorar catálogo</span>
        </NuxtLink>
      </div>
    </div>

    <!-- Estado: Cargando -->
    <div
      v-else-if="status === 'pending'"
      class="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-16 text-center shadow-sm"
    >
      <UIcon name="i-lucide-loader-circle" class="size-8 animate-spin text-neteco-600" />
      <p class="mt-3 text-sm font-medium text-slate-700">Cargando comparativa técnica...</p>
    </div>

    <!-- Estado: Error -->
    <div
      v-else-if="error || !comparison"
      class="flex flex-col items-center justify-center rounded-2xl border border-rose-200 bg-rose-50/50 p-12 text-center"
    >
      <UIcon name="i-lucide-alert-circle" class="size-8 text-rose-600" />
      <h2 class="mt-3 text-base font-bold text-slate-900">No se pudo cargar la comparativa</h2>
      <p class="mt-1 max-w-md text-xs text-slate-600">
        Uno o más de los productos solicitados no existen o no están disponibles públicamente en este momento.
      </p>
      <div class="mt-4 flex gap-2">
        <button
          type="button"
          class="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm border border-slate-200 hover:bg-slate-50"
          @click="() => refresh()"
        >
          Reintentar
        </button>
        <button
          type="button"
          class="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-rose-700"
          @click="clearAll"
        >
          Limpiar comparador
        </button>
      </div>
    </div>

    <!-- Estado: Éxito con datos -->
    <div v-else class="space-y-6">
      <ProductCompareTable :comparison="comparison" @remove="handleRemove" />
    </div>
  </div>
</template>
