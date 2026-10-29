<script setup lang="ts">
import type { CategoryResponse } from '~~/shared/types/catalog'
import AdminCatalogQualityQueue from '~/components/AdminCatalogQualityQueue.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Calidad del catálogo · Admin' })
const runtime = useRuntimeConfig()
const cloudflare = computed(() => runtime.public.serverRuntime === 'cloudflare')
const { data: categoryData } = await useFetch<CategoryResponse>('/api/admin/categories', {
  key: 'admin-categories',
  immediate: cloudflare.value
})
const categories = computed(() =>
  (categoryData.value?.flat ?? []).map((category) => ({ id: category.id, slug: category.slug, name: category.name }))
)

function openProduct(productId: string) {
  return navigateTo(`/admin/productos/${encodeURIComponent(productId)}`)
}
</script>

<template>
  <div class="space-y-6">
    <header>
      <h1 class="text-2xl font-semibold">Calidad del catálogo</h1>
      <p class="text-sm text-muted">
        Productos ordenados por puntuación y revisión más antigua: campos, atributos, imágenes y documentos que faltan.
      </p>
    </header>
    <AdminCatalogQualityQueue v-if="cloudflare" :categories="categories" @select-product="openProduct" />
    <p v-else role="status">La cola de calidad sólo está disponible en el runtime Cloudflare.</p>
  </div>
</template>
