<script setup lang="ts">
import type { SearchSuggestion } from '~~/shared/types/catalog'

const props = defineProps<{ size?: 'sm' | 'md' | 'lg' | 'xl'; placeholder?: string }>()

const q = ref('')
const items = ref<SearchSuggestion[]>([])
const open = ref(false)
const loading = ref(false)
const active = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

watch(q, (val) => {
  clearTimeout(timer)
  active.value = -1
  if (val.trim().length < 2) {
    items.value = []
    open.value = false
    return
  }
  timer = setTimeout(async () => {
    loading.value = true
    try {
      const res = await $fetch<{ items: SearchSuggestion[] }>('/api/search', { params: { q: val.trim() } })
      items.value = res.items
      open.value = true
    } catch {
      items.value = []
    } finally {
      loading.value = false
    }
  }, 200)
})

const router = useRouter()
const route = useRoute()
watch(
  () => route.fullPath,
  () => (open.value = false)
)

function goToResults() {
  if (!q.value.trim()) return
  open.value = false
  router.push({ path: '/buscar', query: { q: q.value.trim() } })
}

function select(item: SearchSuggestion) {
  open.value = false
  q.value = ''
  router.push(`/producto/${item.slug}`)
}

function onEnter() {
  const item = items.value[active.value]
  if (open.value && active.value >= 0 && item) select(item)
  else goToResults()
}

function move(delta: number) {
  if (!open.value || !items.value.length) return
  active.value = (active.value + delta + items.value.length) % items.value.length
}

// cierra solo cuando el foco sale del componente (permite Tab hacia las opciones)
function onFocusOut(e: FocusEvent) {
  if (rootEl.value && e.relatedTarget instanceof Node && rootEl.value.contains(e.relatedTarget)) return
  open.value = false
}
</script>

<template>
  <div ref="rootEl" class="relative w-full" @focusout="onFocusOut" @keydown.esc="open = false">
    <UInput
      v-model="q"
      icon="i-lucide-search"
      :size="props.size ?? 'md'"
      :loading="loading"
      :placeholder="props.placeholder ?? 'Busca por nombre o referencia…'"
      class="w-full"
      role="combobox"
      aria-label="Buscar productos"
      :aria-expanded="open"
      aria-controls="search-listbox"
      aria-autocomplete="list"
      @keydown.enter="onEnter"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @focus="q.trim().length >= 2 && (open = true)"
    />

    <div
      v-if="open"
      id="search-listbox"
      role="listbox"
      class="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
    >
      <template v-if="items.length">
        <button
          v-for="(item, i) in items"
          :key="item.slug"
          type="button"
          role="option"
          :aria-selected="i === active"
          class="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-neteco-50"
          :class="i === active ? 'bg-neteco-50' : ''"
          @click="select(item)"
          @mousemove="active = i"
        >
          <div class="w-10 shrink-0"><ProductImage :product="item" /></div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-slate-800">{{ item.name }}</p>
            <p v-if="item.brand" class="text-xs text-slate-500">{{ item.brand }}</p>
          </div>
          <span class="text-sm font-semibold text-neteco-700">{{ formatPrice(item.minPrice) }}</span>
        </button>
        <button
          type="button"
          class="w-full border-t border-slate-100 px-3 py-2 text-center text-sm font-medium text-neteco-600 hover:bg-neteco-50"
          @click="goToResults"
        >
          Ver todos los resultados de «{{ q }}»
        </button>
      </template>
      <p v-else class="px-3 py-4 text-center text-sm text-slate-500">Sin resultados para «{{ q }}»</p>
    </div>
  </div>
</template>
