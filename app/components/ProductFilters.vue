<script setup lang="ts">
// Panel de filtros por capas. Muta directamente el objeto reactivo `filters`
// que le pasa la página (catálogo, categoría o búsqueda) — una sola fuente de verdad.
const props = defineProps<{
  facets: {
    brands?: Array<{ value: string; n: number }>
    badges?: Array<{ value: string; n: number }>
    envases?: Array<{ value: string; n: number }>
    tallas?: Array<{ value: string; n: number }>
    capacidades?: Array<{ value: string; n: number }>
    colores?: Array<{ value: string; n: number; hex: string | null }>
    medidas?: Array<{ value: string; n: number }>
    acabados?: Array<{ value: string; n: number }>
    price?: { min: number; max: number } | null
  } | null
  filters: {
    brands: string[]
    badges: string[]
    envases: string[]
    tallas: string[]
    capacidades: string[]
    colors?: string[]
    medidas?: string[]
    acabados?: string[]
    priceMin: number | null
    priceMax: number | null
  }
  // secciones a ocultar en una vista concreta (p. ej. 'gama' en el catálogo completo)
  hide?: string[]
}>()

const open = reactive<Record<string, boolean>>({
  marca: true,
  precio: true,
  etiquetas: true,
  envase: true,
  capacidad: true,
  talla: true,
  medida: true,
  acabado: true,
  color: true
})

function toggle(list: string[], value: string) {
  const i = list.indexOf(value)
  if (i >= 0) list.splice(i, 1)
  else list.push(value)
}

// ——— marcas: lista con "ver más" cuando crece ———
const showAllBrands = ref(false)
const visibleBrands = computed(() => {
  const all = props.facets?.brands ?? []
  return showAllBrands.value ? all : all.slice(0, 8)
})

// ——— precio: slider de rango doble + entradas numéricas ———
const bounds = computed(() => {
  const p = props.facets?.price
  if (!p) return { min: 0, max: 100 }
  return { min: Math.floor(p.min / 100), max: Math.ceil(p.max / 100) }
})
const lo = ref(props.filters.priceMin ?? bounds.value.min)
const hi = ref(props.filters.priceMax ?? bounds.value.max)

watch(bounds, (b) => {
  if (props.filters.priceMin == null) lo.value = b.min
  if (props.filters.priceMax == null) hi.value = b.max
})
watch(
  () => [props.filters.priceMin, props.filters.priceMax],
  ([min, max]) => {
    lo.value = min ?? bounds.value.min
    hi.value = max ?? bounds.value.max
  }
)
function onLo(e: Event) {
  lo.value = Math.min(Number((e.target as HTMLInputElement).value), hi.value)
}
function onHi(e: Event) {
  hi.value = Math.max(Number((e.target as HTMLInputElement).value), lo.value)
}
function commitPrice() {
  props.filters.priceMin = lo.value > bounds.value.min ? lo.value : null
  props.filters.priceMax = hi.value < bounds.value.max ? hi.value : null
}
const segStyle = computed(() => {
  const span = Math.max(bounds.value.max - bounds.value.min, 1)
  const left = ((lo.value - bounds.value.min) / span) * 100
  const width = ((hi.value - lo.value) / span) * 100
  return { left: `${left}%`, width: `${width}%` }
})
const priceActive = computed(() => (props.filters.priceMin != null || props.filters.priceMax != null ? 1 : 0))

const THUMB =
  'pointer-events-none absolute inset-x-0 top-1/2 h-6 w-full -translate-y-1/2 appearance-none bg-transparent ' +
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none ' +
  '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-neteco-600 ' +
  '[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:cursor-grab ' +
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full ' +
  '[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-neteco-600 [&::-moz-range-thumb]:bg-white'
</script>

<template>
  <div class="divide-y divide-slate-100">
    <!-- gama (solo si hay más de una: con una sola no filtra nada) -->
    <section v-if="(facets?.brands?.length ?? 0) > 1 && !hide?.includes('gama')" class="py-4 first:pt-0">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.marca"
        @click="open.marca = !open.marca"
      >
        <span class="flex items-center gap-2">
          Gama
          <span
            v-if="filters.brands.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.brands.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.marca ? 'rotate-180' : ''" />
      </button>
      <ul v-show="open.marca" class="mt-2">
        <li v-for="b in visibleBrands" :key="b.value">
          <label
            class="group -mx-2 flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 transition hover:bg-slate-50"
          >
            <input
              type="checkbox"
              class="sr-only"
              :checked="filters.brands.includes(b.value)"
              @change="toggle(filters.brands, b.value)"
            >
            <span
              class="grid size-5 shrink-0 place-items-center rounded-md border-2 transition"
              :class="
                filters.brands.includes(b.value)
                  ? 'border-neteco-600 bg-neteco-600 text-white'
                  : 'border-slate-300 bg-white group-hover:border-neteco-400'
              "
            >
              <UIcon v-if="filters.brands.includes(b.value)" name="i-lucide-check" class="size-3.5" />
            </span>
            <span class="flex-1 text-sm text-slate-700">{{ b.value }}</span>
            <span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-500">{{ b.n }}</span>
          </label>
        </li>
        <li v-if="(facets?.brands?.length ?? 0) > 8">
          <button
            class="mt-1 px-2 text-sm font-medium text-neteco-600 hover:text-neteco-500"
            @click="showAllBrands = !showAllBrands"
          >
            {{ showAllBrands ? 'Ver menos' : `Ver las ${facets!.brands!.length} gamas` }}
          </button>
        </li>
      </ul>
    </section>

    <!-- precio -->
    <section v-if="facets?.price && bounds.max > bounds.min" class="py-4 first:pt-0">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.precio"
        @click="open.precio = !open.precio"
      >
        <span class="flex items-center gap-2">
          Precio
          <span
            v-if="priceActive"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ priceActive }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.precio ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.precio" class="mt-4 px-1">
        <!-- slider doble -->
        <div class="relative h-6">
          <div class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
          <div class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-neteco-500" :style="segStyle" />
          <input
            type="range"
            :min="bounds.min"
            :max="bounds.max"
            :value="lo"
            aria-label="Precio mínimo"
            :class="THUMB"
            @input="onLo"
            @change="commitPrice"
          >
          <input
            type="range"
            :min="bounds.min"
            :max="bounds.max"
            :value="hi"
            aria-label="Precio máximo"
            :class="THUMB"
            @input="onHi"
            @change="commitPrice"
          >
        </div>
        <div class="mt-3 flex items-center justify-between gap-2">
          <div class="relative">
            <input
              :value="lo"
              type="number"
              inputmode="numeric"
              :min="bounds.min"
              :max="bounds.max"
              aria-label="Precio mínimo en euros"
              class="w-20 rounded-lg border border-slate-300 py-1.5 pl-2.5 pr-6 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
              @change="(e) => { onLo(e); commitPrice() }"
            >
            <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">€</span>
          </div>
          <span class="text-slate-300">–</span>
          <div class="relative">
            <input
              :value="hi"
              type="number"
              inputmode="numeric"
              :min="bounds.min"
              :max="bounds.max"
              aria-label="Precio máximo en euros"
              class="w-20 rounded-lg border border-slate-300 py-1.5 pl-2.5 pr-6 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
              @change="(e) => { onHi(e); commitPrice() }"
            >
            <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">€</span>
          </div>
        </div>
      </div>
    </section>

    <!-- características -->
    <section v-if="facets?.badges?.length" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.etiquetas"
        @click="open.etiquetas = !open.etiquetas"
      >
        <span class="flex items-center gap-2">
          Características
          <span
            v-if="filters.badges.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.badges.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.etiquetas ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.etiquetas" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="b in facets.badges"
          :key="b.value"
          :aria-pressed="filters.badges.includes(b.value)"
          class="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.badges.includes(b.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.badges, b.value)"
        >
          <UIcon v-if="BADGES[b.value]" :name="BADGES[b.value]!.icon" class="size-3.5" />
          {{ BADGES[b.value]?.label ?? b.value }}
          <span :class="filters.badges.includes(b.value) ? 'text-neteco-100' : 'text-slate-400'">{{ b.n }}</span>
        </button>
      </div>
    </section>

    <!-- tipo de envase: mosaico con las siluetas de la tienda -->
    <section v-if="(facets?.envases?.length ?? 0) > 1" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.envase"
        @click="open.envase = !open.envase"
      >
        <span class="flex items-center gap-2">
          Tipo de envase
          <span
            v-if="filters.envases.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.envases.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.envase ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.envase" class="mt-3 grid grid-cols-3 gap-1.5">
        <button
          v-for="e in facets.envases"
          :key="e.value"
          :aria-pressed="filters.envases.includes(e.value)"
          class="flex flex-col items-center gap-0.5 rounded-xl border-2 p-1.5 pb-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.envases.includes(e.value)
              ? 'border-neteco-600 bg-neteco-50'
              : 'border-slate-200 bg-white hover:border-neteco-300'
          "
          @click="toggle(filters.envases, e.value)"
        >
          <span class="w-9">
            <ProductVisual :visual="{ type: e.value, color: filters.envases.includes(e.value) ? '#009ac9' : '#94a3b8' }" />
          </span>
          <span class="text-center text-[11px] leading-tight text-slate-700">{{ ENVASE_LABELS[e.value] ?? e.value }}</span>
          <span class="text-[10px] tabular-nums text-slate-400">{{ e.n }}</span>
        </button>
      </div>
    </section>

    <!-- capacidad del envase -->
    <section v-if="(facets?.capacidades?.length ?? 0) > 1" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.capacidad"
        @click="open.capacidad = !open.capacidad"
      >
        <span class="flex items-center gap-2">
          Capacidad
          <span
            v-if="filters.capacidades.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.capacidades.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.capacidad ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.capacidad" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="c in facets.capacidades"
          :key="c.value"
          :aria-pressed="filters.capacidades.includes(c.value)"
          class="rounded-lg border px-2.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.capacidades.includes(c.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.capacidades, c.value)"
        >
          {{ formatCapacity(c.value) }}
          <span :class="filters.capacidades.includes(c.value) ? 'text-neteco-100' : 'text-slate-400'">{{ c.n }}</span>
        </button>
      </div>
    </section>

    <!-- talla (guantes y vestuario) -->
    <section v-if="facets?.tallas?.length" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.talla"
        @click="open.talla = !open.talla"
      >
        <span class="flex items-center gap-2">
          Talla
          <span
            v-if="filters.tallas.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.tallas.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.talla ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.talla" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="t in facets.tallas"
          :key="t.value"
          :aria-pressed="filters.tallas.includes(t.value)"
          class="min-w-11 rounded-lg border px-2.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.tallas.includes(t.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.tallas, t.value)"
        >
          {{ t.value }}
        </button>
      </div>
    </section>

    <!-- medida (mantelería y similares) -->
    <section v-if="filters.medidas && facets?.medidas?.length" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.medida"
        @click="open.medida = !open.medida"
      >
        <span class="flex items-center gap-2">
          Medida
          <span
            v-if="filters.medidas.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.medidas.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.medida ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.medida" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="m in facets.medidas"
          :key="m.value"
          :aria-pressed="filters.medidas.includes(m.value)"
          class="rounded-lg border px-2.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.medidas.includes(m.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.medidas, m.value)"
        >
          {{ m.value }}
          <span :class="filters.medidas.includes(m.value) ? 'text-neteco-100' : 'text-slate-400'">{{ m.n }}</span>
        </button>
      </div>
    </section>

    <!-- acabado (precortado / sin precorte…) -->
    <section v-if="filters.acabados && facets?.acabados?.length" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.acabado"
        @click="open.acabado = !open.acabado"
      >
        <span class="flex items-center gap-2">
          Acabado
          <span
            v-if="filters.acabados.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.acabados.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.acabado ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.acabado" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="a in facets.acabados"
          :key="a.value"
          :aria-pressed="filters.acabados.includes(a.value)"
          class="rounded-lg border px-2.5 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.acabados.includes(a.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.acabados, a.value)"
        >
          {{ a.value }}
          <span :class="filters.acabados.includes(a.value) ? 'text-neteco-100' : 'text-slate-400'">{{ a.n }}</span>
        </button>
      </div>
    </section>

    <!-- color (con la muestra real de cada tono) -->
    <section v-if="filters.colors && facets?.colores?.length" class="py-4">
      <button
        class="flex w-full items-center justify-between text-sm font-semibold text-slate-800"
        :aria-expanded="open.color"
        @click="open.color = !open.color"
      >
        <span class="flex items-center gap-2">
          Color
          <span
            v-if="filters.colors.length"
            class="grid size-5 place-items-center rounded-full bg-neteco-600 text-[11px] font-bold text-white"
          >
            {{ filters.colors.length }}
          </span>
        </span>
        <UIcon name="i-lucide-chevron-down" class="size-4 text-slate-400 transition-transform" :class="open.color ? 'rotate-180' : ''" />
      </button>
      <div v-show="open.color" class="mt-3 flex flex-wrap gap-1.5">
        <button
          v-for="c in facets.colores"
          :key="c.value"
          :aria-pressed="filters.colors.includes(c.value)"
          :title="c.value"
          class="flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          :class="
            filters.colors.includes(c.value)
              ? 'border-neteco-600 bg-neteco-600 text-white'
              : 'border-slate-200 bg-white text-slate-600 hover:border-neteco-300'
          "
          @click="toggle(filters.colors, c.value)"
        >
          <span class="size-3.5 shrink-0 rounded-full border border-black/15" :style="{ backgroundColor: c.hex ?? '#e2e8f0' }" />
          {{ c.value.replace(/\s*\([^)]*\)$/, '') }}
        </button>
      </div>
    </section>
  </div>
</template>
