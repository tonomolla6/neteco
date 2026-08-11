<script setup lang="ts">
const view = useCatalogView()
</script>

<template>
  <div class="flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="Modo de vista">
    <button
      aria-label="Vista de cuadrícula"
      :aria-pressed="view === 'grid'"
      class="rounded-md p-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
      :class="view === 'grid' ? 'bg-neteco-600 text-white' : 'text-slate-500 hover:text-neteco-600'"
      @click="view = 'grid'"
    >
      <UIcon name="i-lucide-layout-grid" class="block size-4" />
    </button>
    <button
      aria-label="Vista de lista"
      :aria-pressed="view === 'list'"
      class="rounded-md p-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
      :class="view === 'list' ? 'bg-neteco-600 text-white' : 'text-slate-500 hover:text-neteco-600'"
      @click="view = 'list'"
    >
      <UIcon name="i-lucide-rows-3" class="block size-4" />
    </button>
  </div>
</template>
