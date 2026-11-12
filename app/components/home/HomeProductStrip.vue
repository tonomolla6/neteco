<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

/**
 * Franja horizontal de productos, como las filas de un gran almacén online.
 *
 * Sirve para «ir viendo cosas»: en móvil asoma la tarjeta siguiente para que se entienda
 * que la fila sigue y se desliza con el dedo; en escritorio, con las flechas de la cabecera.
 * Cada tarjeta es la tarjeta de pedido normal: se añade al carrito sin salir de la portada.
 */
const props = defineProps<{
  title: string
  items: ProductCardData[]
  to?: string
  linkLabel?: string
  /** Una línea bajo el título; opcional. */
  subtitle?: string
}>()

const headingId = `strip-${useId()}`
const track = ref<HTMLElement | null>(null)
const atStart = ref(true)
const atEnd = ref(false)

function update() {
  const element = track.value
  if (!element) return
  atStart.value = element.scrollLeft <= 4
  atEnd.value = element.scrollLeft + element.clientWidth >= element.scrollWidth - 4
}

function page(direction: 1 | -1) {
  const element = track.value
  if (!element) return
  element.scrollBy({ left: direction * element.clientWidth * 0.9, behavior: 'smooth' })
}

onMounted(update)
watch(
  () => props.items.length,
  () => nextTick(update)
)
</script>

<template>
  <section v-if="items.length" :aria-labelledby="headingId" class="mx-auto max-w-[1440px] py-6 sm:py-8">
    <div class="mb-3 flex items-end justify-between gap-3 px-4 sm:px-6">
      <div class="min-w-0">
        <h2 :id="headingId" class="text-xl font-bold text-[var(--text-strong)] sm:text-2xl">{{ title }}</h2>
        <p v-if="subtitle" class="mt-0.5 text-sm text-[var(--text-muted)]">{{ subtitle }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <NuxtLink
          v-if="to"
          :to="to"
          class="text-sm font-semibold text-[var(--link)] underline-offset-4 hover:underline"
        >
          {{ linkLabel ?? 'Ver todo' }}
        </NuxtLink>
        <div v-if="items.length > 2" class="hidden gap-1 md:flex">
          <button
            type="button"
            class="grid size-9 place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-strong)] transition hover:bg-[var(--surface-sunken)] disabled:opacity-40"
            :disabled="atStart"
            :aria-label="`Anteriores en ${title}`"
            @click="page(-1)"
          >
            <UIcon name="i-lucide-chevron-left" class="size-4" />
          </button>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-strong)] transition hover:bg-[var(--surface-sunken)] disabled:opacity-40"
            :disabled="atEnd"
            :aria-label="`Siguientes en ${title}`"
            @click="page(1)"
          >
            <UIcon name="i-lucide-chevron-right" class="size-4" />
          </button>
        </div>
      </div>
    </div>
    <ul
      ref="track"
      class="scrollbar-none flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 sm:scroll-px-6 sm:gap-4 sm:px-6"
      @scroll.passive="update"
    >
      <li
        v-for="product in items"
        :key="product.id"
        class="flex w-[44%] shrink-0 snap-start sm:w-[220px] lg:w-[236px] [&>*]:w-full"
      >
        <ProductCard :product="product" />
      </li>
    </ul>
  </section>
</template>
