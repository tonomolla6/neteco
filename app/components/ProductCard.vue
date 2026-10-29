<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

const props = defineProps<{
  product: ProductCardData
}>()
const runtime = useRuntimeConfig()
const showNetPrices = computed(() => runtime.public.priceDisplayMode === 'net-and-gross')

// con títulos del ERP tipo «NETTION MC», el eyebrow de marca sería redundante
const showBrand = computed(
  () => !!props.product.brand && !props.product.name.toUpperCase().startsWith(props.product.brand.toUpperCase())
)

/**
 * Ahorro sobre el precio anterior. Se muestra solo si es real y significativo: por debajo
 * del 5 % un «−3 %» resta credibilidad en lugar de sumarla.
 */
const discount = computed(() => {
  const before = props.product.compareAtPrice
  const now = props.product.minPrice
  if (!before || before <= now) return null
  const percent = Math.round(((before - now) / before) * 100)
  return percent >= 5 ? { before, percent } : null
})

const COMPARE_STORAGE_KEY = 'neteco_compare_slugs'
const isCompared = ref(false)

function readStoredCompareSlugs(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(COMPARE_STORAGE_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStoredCompareSlugs(slugs: string[]) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify(slugs))
      window.dispatchEvent(new Event('neteco_compare_updated'))
    }
  } catch {
    // Quota or access error handling
  }
}

function syncCompare() {
  const current = readStoredCompareSlugs()
  isCompared.value = current.includes(props.product.slug)
}

onMounted(() => {
  syncCompare()
  if (typeof window !== 'undefined') {
    window.addEventListener('neteco_compare_updated', syncCompare)
    window.addEventListener('storage', syncCompare)
  }
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('neteco_compare_updated', syncCompare)
    window.removeEventListener('storage', syncCompare)
  }
})

function toggleCompare(event: Event) {
  event.preventDefault()
  event.stopPropagation()
  const current = readStoredCompareSlugs()
  if (current.includes(props.product.slug)) {
    writeStoredCompareSlugs(current.filter((s) => s !== props.product.slug))
    isCompared.value = false
  } else {
    if (current.length >= 4) {
      return
    }
    writeStoredCompareSlugs([...current, props.product.slug])
    isCompared.value = true
  }
}
</script>

<template>
  <NuxtLink
    :to="`/producto/${product.slug}`"
    class="group flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-neteco-300 hover:shadow-lg hover:shadow-neteco-500/10"
  >
    <div class="relative">
      <div class="mx-auto w-full max-w-[190px]">
        <ProductImage :product="product" />
      </div>
      <div class="absolute left-2 top-2 flex flex-col items-start gap-1">
        <UBadge v-if="discount" color="error" variant="solid" class="font-bold"> −{{ discount.percent }} % </UBadge>
        <UBadge
          v-for="b in product.badges"
          :key="b"
          :color="BADGES[b]?.color ?? 'neutral'"
          :icon="BADGES[b]?.icon"
          variant="subtle"
        >
          {{ BADGES[b]?.label ?? b }}
        </UBadge>
      </div>
      <div class="absolute right-2 top-2 z-10">
        <button
          type="button"
          :aria-pressed="isCompared"
          :aria-label="isCompared ? `Quitar ${product.name} de comparar` : `Comparar ${product.name}`"
          :title="isCompared ? 'Quitar de comparar' : 'Añadir a comparar (máx. 4)'"
          :class="[
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold shadow-sm transition border',
            isCompared
              ? 'bg-neteco-600 border-neteco-700 text-white shadow-neteco-500/20'
              : 'bg-white/95 border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-neteco-600'
          ]"
          @click.stop.prevent="toggleCompare"
        >
          <UIcon :name="isCompared ? 'i-lucide-check' : 'i-lucide-columns-2'" class="size-3.5" />
          <span>{{ isCompared ? 'Comparando' : 'Comparar' }}</span>
        </button>
      </div>
    </div>

    <div>
      <p v-if="showBrand" class="text-[11px] font-semibold uppercase tracking-wider text-neteco-600">
        {{ product.brand }}
      </p>
      <p class="line-clamp-2 text-sm font-semibold leading-snug text-slate-800 group-hover:text-neteco-700">
        {{ product.name }}
      </p>
    </div>

    <div class="mt-auto flex items-end justify-between">
      <div>
        <!-- La base fiscal se dice SIEMPRE igual en todas las tarjetas y el «desde» va pegado
             al importe. Antes un ternario producía tres cualificadores distintos según el
             producto («5 formatos · desde», «IVA incluido», «sin IVA»), de modo que en la misma
             rejilla una tarjeta hablaba de formatos y la de al lado de impuestos, y no se podían
             comparar de un vistazo. -->
        <p
          class="tabular font-display text-lg font-bold"
          :class="discount ? 'text-red-700' : 'text-[var(--text-strong)]'"
        >
          <span v-if="product.formats > 1" class="font-sans text-xs font-medium text-[var(--text-muted)]">desde </span>
          {{ formatPrice(showNetPrices ? product.minNetPrice : product.minPrice) }}
        </p>
        <p class="text-[11px] text-[var(--text-muted)]">
          <template v-if="discount">
            <s class="tabular">{{ formatPrice(discount.before) }}</s> ·
          </template>
          {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
          <template v-if="product.formats > 1"> · {{ product.formats }} formatos</template>
        </p>
      </div>
      <span
        class="rounded-full bg-neteco-50 p-2 text-neteco-600 transition group-hover:bg-neteco-500 group-hover:text-white"
      >
        <UIcon name="i-lucide-arrow-right" class="block size-4" />
      </span>
    </div>
  </NuxtLink>
</template>
