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

function openProduct(productId: number | string) {
  return navigateTo(`/admin/productos/${encodeURIComponent(productId)}`)
}
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <AdminCatalogQualityQueue v-if="cloudflare" :categories="categories" @select-product="openProduct" />
      <div v-else role="status">
        <AdminEmptyState
          icon="i-lucide-badge-check"
          title="La revisión de calidad no está disponible"
          description="Esta instalación de la tienda no permite revisar la calidad de las fichas desde el panel."
        />
      </div>
    </div>
  </AdminPage>
</template>
