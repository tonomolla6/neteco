<script setup lang="ts">
import {
  recommendationSubtitle,
  recommendationTitle,
  type RecommendationStrip
} from '~~/shared/product-recommendations'

/**
 * Franjas de productos recomendados en fila deslizable. En escritorio se ven todas (hasta
 * tres); en móvil solo las `mobileCount` primeras, para no alargar la página del pulgar.
 */
const props = withDefaults(
  defineProps<{
    strips: RecommendationStrip[]
    loading?: boolean
    mobileCount?: number
    /** Franjas que se esperan, para reservar su alto mientras cargan. */
    placeholders?: number
  }>(),
  { loading: false, mobileCount: 1, placeholders: 0 }
)

const rows = ref<Record<string, HTMLElement | null>>({})
function scroll(kind: string, direction: 1 | -1) {
  const row = rows.value[kind]
  if (row) row.scrollBy({ left: direction * row.clientWidth * 0.9, behavior: 'smooth' })
}
const visible = computed(() => props.strips.filter((strip) => strip.items.length >= 2))
</script>

<template>
  <div v-if="loading && placeholders" class="space-y-10" aria-hidden="true">
    <div v-for="n in placeholders" :key="n" :class="n > mobileCount ? 'hidden lg:block' : ''">
      <div class="h-6 w-64 animate-pulse rounded bg-[var(--surface-sunken)]" />
      <div class="mt-4 flex gap-4 overflow-hidden">
        <div
          v-for="m in 5"
          :key="m"
          class="h-72 w-[46%] shrink-0 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)] sm:w-[30%] lg:w-[19%]"
        />
      </div>
    </div>
  </div>
  <div v-else-if="visible.length" class="space-y-10" data-recommendation-strips>
    <section
      v-for="(strip, index) in visible"
      :key="strip.kind"
      :data-recommendation-strip="strip.kind"
      :data-recommendation-basis="strip.basis"
      :aria-labelledby="`rec-${strip.kind}`"
      :class="index >= mobileCount ? 'hidden lg:block' : ''"
      class="min-w-0"
    >
      <div class="flex items-end justify-between gap-3">
        <div class="min-w-0">
          <h2 :id="`rec-${strip.kind}`" class="text-lg font-bold text-[var(--text-strong)] lg:text-[22px]">
            {{ recommendationTitle(strip) }}
          </h2>
          <p v-if="recommendationSubtitle(strip)" class="mt-0.5 text-[13px] text-[var(--text-muted)]">
            {{ recommendationSubtitle(strip) }}
          </p>
        </div>
        <div v-if="strip.items.length > 4" class="hidden shrink-0 gap-2 lg:flex">
          <button
            type="button"
            class="inline-flex size-10 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-strong)] hover:border-[var(--action)]"
            :aria-label="`Anteriores en «${recommendationTitle(strip)}»`"
            @click="scroll(strip.kind, -1)"
          >
            <UIcon name="i-lucide-chevron-left" class="size-5" />
          </button>
          <button
            type="button"
            class="inline-flex size-10 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-strong)] hover:border-[var(--action)]"
            :aria-label="`Siguientes en «${recommendationTitle(strip)}»`"
            @click="scroll(strip.kind, 1)"
          >
            <UIcon name="i-lucide-chevron-right" class="size-5" />
          </button>
        </div>
      </div>
      <ul
        :ref="(element) => (rows[strip.kind] = element as HTMLElement | null)"
        class="scrollbar-none -mx-4 mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:gap-4 lg:mx-0 lg:px-0"
      >
        <li
          v-for="item in strip.items"
          :key="item.id"
          class="w-[46%] shrink-0 snap-start sm:w-[31%] md:w-[23%] lg:w-[calc((100%-4rem)/5)]"
        >
          <ProductCard :product="item" class="h-full" />
        </li>
      </ul>
    </section>
  </div>
</template>
