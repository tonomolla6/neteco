<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

defineProps<{ items: ProductCardData[]; pending?: boolean }>()
const view = useCatalogView()
</script>

<template>
  <!-- esqueletos mientras llega la primera tanda -->
  <div
    v-if="pending && !items.length && view === 'grid'"
    class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
    aria-hidden="true"
  >
    <div
      v-for="i in 10"
      :key="i"
      class="flex animate-pulse flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div class="aspect-square w-full rounded-2xl bg-slate-100" />
      <div class="h-4 w-3/4 rounded bg-slate-100" />
      <div class="h-3 w-1/2 rounded bg-slate-100" />
      <div class="mt-2 h-6 w-1/3 rounded bg-slate-100" />
    </div>
  </div>
  <div v-else-if="pending && !items.length" class="flex flex-col gap-2" aria-hidden="true">
    <div
      v-for="i in 8"
      :key="i"
      class="flex animate-pulse items-center gap-4 rounded-xl border border-slate-200 bg-white p-3"
    >
      <div class="size-16 shrink-0 rounded-xl bg-slate-100" />
      <div class="flex-1 space-y-2">
        <div class="h-4 w-1/2 rounded bg-slate-100" />
        <div class="h-3 w-1/3 rounded bg-slate-100" />
      </div>
      <div class="h-6 w-20 rounded bg-slate-100" />
    </div>
  </div>

  <div
    v-else-if="view === 'grid'"
    class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
    :class="pending ? 'opacity-60' : ''"
  >
    <ProductCard v-for="p in items" :key="p.id" :product="p" />
  </div>
  <div v-else class="flex flex-col gap-2" :class="pending ? 'opacity-60' : ''">
    <ProductRow v-for="p in items" :key="p.id" :product="p" />
  </div>
</template>
