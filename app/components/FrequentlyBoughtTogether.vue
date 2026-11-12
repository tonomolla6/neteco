<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import { hasPublicPrice } from '~~/shared/price-on-request'
import {
  recommendationSubtitle,
  recommendationTitle,
  type RecommendationStrip
} from '~~/shared/product-recommendations'
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * «Comprados juntos frecuentemente»: el producto de la ficha (o nada, en el carrito) más dos o
 * tres complementos con casilla y un solo botón que los añade. El total se ve antes de pulsar
 * y cada casilla se puede desmarcar; solo vienen marcados los que tienen relación real
 * (co-compra o complemento curado), que es lo único que llega en esta franja.
 *
 * Solo se añaden de un clic los productos de un único formato; los demás llevan a su ficha
 * para elegir formato, sin adivinar por el cliente.
 */
const props = withDefaults(
  defineProps<{
    strip: RecommendationStrip
    /** Producto de la ficha: va primero, siempre marcado y se añade con su propia lógica. */
    main?: {
      name: string
      image: string | null
      visual: ProductCardData['visual']
      grossCents: number
      netCents: number
      detail: string
      add: () => Promise<boolean>
    } | null
    max?: number
  }>(),
  { main: null, max: 3 }
)

const cart = useCartStore()
const toast = useToast()
const { net: showNetPrices } = usePriceDisplay()

const items = computed(() =>
  props.strip.items
    .filter((item) => hasPublicPrice(item.minPrice))
    .slice(0, props.max)
    .map((item) => {
      const single = item.single ?? null
      const availability = single ? variantAvailability(single) : null
      return { item, single, direct: Boolean(single && availability?.orderable) }
    })
)
const checked = ref(new Set<number>())
watch(items, (list) => (checked.value = new Set(list.filter((entry) => entry.direct).map((entry) => entry.item.id))), {
  immediate: true
})
function toggle(id: number) {
  const next = new Set(checked.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  checked.value = next
}

const selected = computed(() => items.value.filter((entry) => entry.direct && checked.value.has(entry.item.id)))
const quantityOf = (entry: (typeof items.value)[number]) => entry.single?.minimumQuantity ?? 1
const total = computed(() => {
  const extras = selected.value.reduce(
    (sum, entry) => ({
      gross: sum.gross + entry.item.minPrice * quantityOf(entry),
      net: sum.net + entry.item.minNetPrice * quantityOf(entry)
    }),
    { gross: 0, net: 0 }
  )
  return {
    gross: extras.gross + (props.main?.grossCents ?? 0),
    net: extras.net + (props.main?.netCents ?? 0)
  }
})
const count = computed(() => selected.value.length + (props.main ? 1 : 0))
const adding = ref(false)

async function addAll() {
  if (adding.value || !count.value) return
  adding.value = true
  let added = 0
  try {
    if (props.main) {
      if (!(await props.main.add())) return
      added++
    }
    for (const entry of selected.value) {
      const { item, single } = entry
      if (!single) continue
      await cart.add(
        {
          productId: item.id,
          slug: item.slug,
          name: item.name,
          brand: item.brand,
          variantId: single.variantId,
          format: single.format,
          sku: single.sku,
          price: item.minPrice,
          netPrice: item.minNetPrice,
          visual: item.visual,
          image: item.image,
          minimumQuantity: single.minimumQuantity,
          maximumQuantity: single.maximumQuantity,
          quantityIncrement: single.quantityIncrement
        },
        single.minimumQuantity
      )
      added++
    }
    toast.add({
      title: added === 1 ? 'Añadido al carrito' : `${added} productos añadidos al carrito`,
      icon: 'i-lucide-shopping-cart',
      color: 'success'
    })
  } catch {
    toast.add({
      title: added ? `Se han añadido ${added}; el resto no se ha podido añadir` : 'No se ha podido añadir',
      description: cart.error || 'Vuelve a intentarlo.',
      icon: 'i-lucide-triangle-alert',
      color: 'error'
    })
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <section
    v-if="items.length"
    data-frequently-bought-together
    :data-recommendation-basis="strip.basis"
    aria-labelledby="fbt-title"
    class="rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
  >
    <h2 id="fbt-title" class="text-lg font-bold text-[var(--text-strong)]">{{ recommendationTitle(strip) }}</h2>
    <p v-if="recommendationSubtitle(strip)" class="mt-0.5 text-[13px] text-[var(--text-muted)]">
      {{ recommendationSubtitle(strip) }}
    </p>

    <div class="mt-4 flex flex-col gap-5 lg:flex-row lg:items-center">
      <!-- Fotos unidas por «+», como se piden juntas -->
      <ol class="hidden items-center gap-2 sm:flex" aria-hidden="true">
        <li v-if="main" class="flex items-center gap-2">
          <span
            class="block size-24 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1"
          >
            <ProductImage :product="{ name: main.name, image: main.image, visual: main.visual }" />
          </span>
        </li>
        <li v-for="(entry, index) in items" :key="entry.item.id" class="flex items-center gap-2">
          <UIcon v-if="main || index > 0" name="i-lucide-plus" class="size-5 text-[var(--text-muted)]" />
          <span
            class="block size-24 overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)] bg-white p-1 transition-opacity"
            :class="entry.direct && !checked.has(entry.item.id) ? 'opacity-40' : ''"
          >
            <ProductImage :product="entry.item" />
          </span>
        </li>
      </ol>

      <div class="min-w-0 flex-1">
        <ul class="space-y-2">
          <li v-if="main" class="flex items-start gap-3 text-[15px]">
            <input
              type="checkbox"
              checked
              disabled
              class="mt-1 size-5 shrink-0 accent-[var(--action)]"
              aria-label="Este producto"
            />
            <span class="min-w-0">
              <strong class="font-semibold text-[var(--text-strong)]">Este producto:</strong>
              <span class="text-[var(--text)]"> {{ main.name }}</span>
              <span class="tabular block text-[13px] text-[var(--text-muted)]">{{ main.detail }}</span>
            </span>
          </li>
          <li v-for="entry in items" :key="entry.item.id" class="flex items-start gap-3 text-[15px]">
            <input
              v-if="entry.direct"
              :id="`fbt-${entry.item.id}`"
              type="checkbox"
              :checked="checked.has(entry.item.id)"
              class="mt-1 size-5 shrink-0 accent-[var(--action)]"
              @change="toggle(entry.item.id)"
            />
            <span v-else class="mt-1 size-5 shrink-0" aria-hidden="true" />
            <span class="min-w-0">
              <label v-if="entry.direct" :for="`fbt-${entry.item.id}`" class="cursor-pointer">
                <span class="text-[var(--text-strong)]">{{ entry.item.name }}</span>
              </label>
              <NuxtLink
                v-else
                :to="`/producto/${entry.item.slug}`"
                class="text-[var(--text-strong)] underline underline-offset-2"
              >
                {{ entry.item.name }}
              </NuxtLink>
              <span class="tabular block text-[13px] text-[var(--text-muted)]">
                <template v-if="entry.single">
                  {{ entry.single.format
                  }}<template v-if="quantityOf(entry) > 1"> × {{ quantityOf(entry) }}</template> ·
                  {{ formatPrice(showNetPrices ? entry.item.minNetPrice : entry.item.minPrice) }}
                </template>
                <template v-else>
                  Desde {{ formatPrice(showNetPrices ? entry.item.minNetPrice : entry.item.minPrice) }} ·
                  {{ entry.item.formats }} formatos, elige el tuyo en su ficha
                </template>
              </span>
              <NuxtLink
                v-if="entry.direct"
                :to="`/producto/${entry.item.slug}`"
                class="text-[13px] text-[var(--link)] underline underline-offset-2"
              >
                Ver ficha
              </NuxtLink>
            </span>
          </li>
        </ul>
      </div>

      <div class="shrink-0 border-t border-[var(--border)] pt-4 lg:w-64 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
        <p class="text-[13px] text-[var(--text-muted)]">
          Total de {{ count }} {{ count === 1 ? 'producto' : 'productos' }}
          {{ showNetPrices ? 'sin IVA' : 'IVA incluido' }}
        </p>
        <p class="tabular font-display text-2xl font-bold text-[var(--text-strong)]">
          {{ formatPrice(showNetPrices ? total.net : total.gross) }}
        </p>
        <button
          type="button"
          data-fbt-add
          :disabled="!count || adding || cart.blockedMutations"
          class="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 font-semibold text-[var(--text-strong)] transition-colors hover:border-[var(--action)] hover:text-[var(--action)] disabled:cursor-not-allowed disabled:opacity-50"
          @click="addAll"
        >
          <UIcon name="i-lucide-shopping-cart" class="size-4" />
          {{
            count === 1
              ? 'Añadir al carrito'
              : count === 2
                ? 'Añadir los dos al carrito'
                : `Añadir los ${count} al carrito`
          }}
        </button>
      </div>
    </div>
  </section>
</template>
