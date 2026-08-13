<script setup lang="ts">
import type { ProductCardData } from '~~/shared/types/catalog'

defineProps<{ items: ProductCardData[]; pending?: boolean }>()
const view = useCatalogView()
</script>

<template>
  <div
    v-if="view === 'grid'"
    class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
    :class="pending ? 'opacity-60' : ''"
  >
    <ProductCard v-for="p in items" :key="p.id" :product="p" />
  </div>
  <div v-else class="flex flex-col gap-2" :class="pending ? 'opacity-60' : ''">
    <ProductListRow v-for="p in items" :key="p.id" :product="p" />
  </div>
</template>
