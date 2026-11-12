<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import type { SearchSuggestion } from '~~/shared/types/catalog'
import { PRICE_ON_REQUEST, PRICE_REQUEST_ACTION, hasPublicPrice, priceRequestPath } from '~~/shared/price-on-request'

const props = defineProps<{
  size?: 'sm' | 'md' | 'lg' | 'xl'
  placeholder?: string
  /**
   * Campo grande con botón «Buscar» a la derecha, para la cabecera móvil y los bloques de
   * pedido: se acierta con el pulgar y no obliga a buscar la tecla Intro del teclado.
   */
  prominent?: boolean
}>()

const q = ref('')
const items = ref<SearchSuggestion[]>([])
const { net: showNetPrices } = usePriceDisplay()
const open = ref(false)
const loading = ref(false)
const errorMessage = ref('')
const active = ref(-1)
const rootEl = ref<HTMLElement | null>(null)
const listboxId = `search-listbox-${useId()}`
const optionId = (index: number) => `${listboxId}-option-${index}`
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
    errorMessage.value = ''
    try {
      const res = await $fetch<{ items: SearchSuggestion[] }>('/api/search', { params: { q: val.trim() } })
      items.value = res.items
      open.value = true
    } catch {
      items.value = []
      open.value = true
      errorMessage.value = 'No se han podido cargar las sugerencias.'
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
  router.push({ path: `/producto/${item.slug}`, query: item.sku ? { sku: item.sku } : {} })
}

/**
 * Añadir desde una sugerencia.
 *
 * Quien teclea la referencia del albarán quiere el producto en el carrito, no una página.
 * Se añade la variante de esa referencia exacta o, si el producto tiene un solo formato, ese.
 * Con varios formatos y sin referencia exacta no se adivina: se dice y se enlaza la ficha.
 */
interface SuggestionDetail {
  id: number
  slug: string
  name: string
  brand: string
  visual: { type: string; color: string }
  variants: Array<{
    id: number
    sku: string
    format: string
    price: number
    netPrice?: number
    minimumQuantity: number
    quantityIncrement: number
    maximumQuantity: number | null
    stock: number
    backorderAllowed: boolean
  }>
}
const cart = useCartStore()
const isExact = (item: SearchSuggestion) => !!item.sku && item.sku === q.value.trim()
const adding = ref('')
const added = ref('')
const announcement = ref('')
const addError = ref('')
const formatsNotice = ref<{ name: string; slug: string } | null>(null)
let addedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => {
  clearTimeout(timer)
  clearTimeout(addedTimer)
})

async function addSuggestion(item: SearchSuggestion) {
  // Sin precio público no se añade: se pide el precio.
  if (adding.value || cart.blockedMutations || !hasPublicPrice(item.minPrice)) return
  adding.value = item.slug
  addError.value = ''
  announcement.value = ''
  formatsNotice.value = null
  const exact = isExact(item) ? item.sku : null
  try {
    const detail = await $fetch<SuggestionDetail>(`/api/products/${encodeURIComponent(item.slug)}`)
    const variant =
      (exact ? detail.variants.find((candidate) => candidate.sku === exact) : undefined) ??
      (detail.variants.length === 1 ? detail.variants[0] : undefined)
    if (!variant) {
      formatsNotice.value = { name: item.name, slug: item.slug }
      return
    }
    if (!hasPublicPrice(variant.price)) {
      formatsNotice.value = null
      addError.value = `${item.name}: ${PRICE_ON_REQUEST.toLowerCase()}.`
      return
    }
    if (!variantAvailability(variant).orderable) {
      addError.value = `${item.name} está agotado ahora mismo.`
      return
    }
    await cart.add(
      {
        productId: detail.id,
        slug: detail.slug,
        name: detail.name,
        brand: detail.brand,
        variantId: variant.id,
        format: variant.format,
        sku: variant.sku,
        price: variant.price,
        visual: detail.visual,
        image: item.image,
        minimumQuantity: variant.minimumQuantity,
        maximumQuantity: variant.maximumQuantity,
        quantityIncrement: variant.quantityIncrement
      },
      variant.minimumQuantity
    )
    added.value = item.slug
    announcement.value = `${variant.minimumQuantity} × ${detail.name} en el carrito`
    clearTimeout(addedTimer)
    addedTimer = setTimeout(() => (added.value = ''), 2000)
  } catch {
    addError.value = cart.error || 'No se ha podido añadir. Vuelve a intentarlo.'
    if (!addError.value.startsWith('No se ha podido añadir'))
      addError.value = `No se ha podido añadir. ${addError.value}`
  } finally {
    adding.value = ''
  }
}

function onEnter() {
  const item = items.value[active.value]
  if (open.value && active.value >= 0 && item) return select(item)
  // Una referencia exacta va la primera: Intro la añade al carrito sin salir de la página.
  const first = items.value[0]
  // Sin precio público, la referencia exacta lleva a su ficha (con «Pedir precio»), no al carrito.
  if (open.value && first && isExact(first))
    return hasPublicPrice(first.minPrice) ? void addSuggestion(first) : select(first)
  goToResults()
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
      :ui="
        props.prominent
          ? {
              base: 'h-12 rounded-[var(--radius-control)] bg-white pe-14 text-base ring-2 ring-neteco-700 focus-visible:ring-neteco-800',
              leadingIcon: 'text-[var(--text-muted)]'
            }
          : undefined
      "
      role="combobox"
      aria-label="Buscar productos"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :aria-activedescendant="active >= 0 ? optionId(active) : undefined"
      aria-autocomplete="list"
      @keydown.enter="onEnter"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @focus="q.trim().length >= 2 && (open = true)"
    >
      <template v-if="props.prominent" #trailing>
        <button
          type="button"
          aria-label="Buscar"
          class="-me-1 grid size-10 place-items-center rounded-[6px] bg-neteco-700 text-white transition-colors hover:bg-neteco-800"
          @click="goToResults"
        >
          <UIcon name="i-lucide-search" class="size-5" />
        </button>
      </template>
    </UInput>

    <div
      v-if="open"
      :id="listboxId"
      role="listbox"
      class="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-overlay)]"
    >
      <p v-if="errorMessage" class="px-3 py-4 text-center text-sm text-red-700" role="alert">
        {{ errorMessage }}
      </p>
      <template v-else-if="items.length">
        <div
          v-for="(item, i) in items"
          :id="optionId(i)"
          :key="item.slug"
          role="option"
          :aria-selected="i === active"
          class="flex w-full items-center gap-3 px-3 py-2 transition-colors"
          :class="i === active ? 'bg-neteco-50' : ''"
          @mousemove="active = i"
        >
          <button
            type="button"
            tabindex="-1"
            class="flex min-w-0 flex-1 items-center gap-3 text-left"
            @click="select(item)"
          >
            <span class="block w-10 shrink-0"><ProductImage :product="item" sizes="40px" /></span>
            <span class="block min-w-0 flex-1">
              <span class="block truncate text-[15px] font-medium text-[var(--text-strong)]">{{ item.name }}</span>
              <span class="tabular block text-[13px] text-[var(--text-muted)]">
                <span v-if="isExact(item)" class="font-semibold text-[var(--stock-ok)]">Referencia exacta · </span>
                <template v-if="item.sku">Ref. {{ item.sku }} · </template>
                <template v-if="hasPublicPrice(item.minPrice)">
                  {{ formatPrice(showNetPrices ? item.minNetPrice : item.minPrice) }}
                  {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
                </template>
                <template v-else>{{ PRICE_ON_REQUEST }}</template>
              </span>
            </span>
          </button>
          <NuxtLink
            v-if="!hasPublicPrice(item.minPrice)"
            :to="priceRequestPath({ slug: item.slug, name: item.name, sku: item.sku })"
            tabindex="-1"
            data-price-request
            class="inline-flex h-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-[15px] font-semibold text-[var(--text-strong)] transition-colors hover:border-[var(--action)] hover:text-[var(--action)]"
            @click="open = false"
            >{{ PRICE_REQUEST_ACTION }}</NuxtLink
          >
          <button
            v-else
            type="button"
            data-suggestion-add
            :disabled="adding === item.slug"
            :aria-label="`Añadir ${item.name} al carrito`"
            class="inline-flex h-11 shrink-0 items-center justify-center gap-1 rounded-[var(--radius-control)] px-3 text-[15px] font-semibold text-white transition-colors disabled:opacity-60"
            :class="added === item.slug ? 'bg-[var(--stock-ok)]' : 'bg-[var(--action)] hover:bg-[var(--action-hover)]'"
            @click.stop="addSuggestion(item)"
          >
            {{ added === item.slug ? 'Añadido' : 'Añadir' }}
          </button>
        </div>
        <p
          v-if="formatsNotice"
          role="status"
          class="border-t border-[var(--border)] px-3 py-2 text-[13px] text-[var(--text)]"
        >
          {{ formatsNotice.name }} tiene varios formatos.
          <NuxtLink :to="`/producto/${formatsNotice.slug}`" class="font-semibold text-[var(--link)] underline">
            Elegir formato
          </NuxtLink>
        </p>
        <p
          v-if="addError"
          role="alert"
          class="border-t border-[var(--border)] px-3 py-2 text-[13px] text-[var(--ui-error)]"
        >
          {{ addError }}
        </p>
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
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>
  </div>
</template>
