<script setup lang="ts">
import type { AdminProductSummary } from '~~/shared/types/admin'
import type { CategoryResponse } from '~~/shared/types/catalog'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Productos · Admin' })

const q = ref('')
const category = ref('')
const estado = ref('')

const { data: catData } = await useFetch<CategoryResponse>('/api/categories', { key: 'categories' })
const catOptions = computed(() => flattenCategoryTree(catData.value?.roots ?? []))

const { data, refresh } = await useFetch<{ items: AdminProductSummary[] }>('/api/admin/products', {
  query: { q, category, status: estado }
})
const items = computed(() => data.value?.items ?? [])

const toast = useToast()

const STATUS_LABELS: Record<AdminProductSummary['status'], string> = {
  draft: 'Borrador',
  review: 'En revisión',
  published: 'Publicado',
  hidden: 'Oculto',
  discontinued: 'Descatalogado'
}
const STATUS_TRANSITIONS: Record<AdminProductSummary['status'], AdminProductSummary['status'][]> = {
  draft: ['review', 'hidden', 'discontinued'],
  review: ['draft', 'published', 'hidden'],
  published: ['hidden', 'discontinued'],
  hidden: ['draft', 'review', 'published', 'discontinued'],
  discontinued: ['draft']
}

async function changeStatus(product: AdminProductSummary, status: AdminProductSummary['status']) {
  try {
    await $fetch(`/api/admin/products/${product.id}/active`, {
      method: 'PUT',
      body: { status, reason: `Transición editorial ${product.status} → ${status}` }
    })
    toast.add({
      title: `«${product.name}»: ${STATUS_LABELS[status]}`,
      icon: status === 'published' ? 'i-lucide-eye' : 'i-lucide-workflow',
      color: 'success'
    })
    refresh()
    refreshNuxtData('categories')
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido cambiar el estado'),
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  }
}

async function removeProduct(product: AdminProductSummary) {
  if (!confirm(`¿Eliminar «${product.name}» y sus ${product.formats} variante(s)? Esta acción no se puede deshacer.`))
    return
  try {
    await $fetch(`/api/admin/products/${product.id}`, { method: 'DELETE' })
    toast.add({ title: 'Producto eliminado', icon: 'i-lucide-trash-2', color: 'success' })
    refresh()
    refreshNuxtData('categories')
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido eliminar'),
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl font-bold text-slate-900">Productos</h1>
      <UButton to="/admin/productos/nuevo" icon="i-lucide-plus">Nuevo producto</UButton>
    </div>

    <div class="mt-4 flex flex-wrap gap-3">
      <UInput v-model="q" icon="i-lucide-search" placeholder="Buscar por nombre, marca o referencia…" class="w-72" />
      <select
        v-model="category"
        aria-label="Filtrar por familia"
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
      >
        <option value="">Todas las familias</option>
        <option v-for="c in catOptions" :key="c.id" :value="String(c.id)">{{ c.label }}</option>
      </select>
      <select
        v-model="estado"
        aria-label="Filtrar por estado"
        class="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
      >
        <option value="">Todos los estados</option>
        <option v-for="(label, value) in STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
      </select>
      <span class="self-center text-sm text-slate-500">{{ items.length }} productos</span>
    </div>

    <div class="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[760px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th class="px-4 py-3">Producto</th>
            <th class="px-4 py-3">Familia</th>
            <th class="px-4 py-3 text-center">Variantes</th>
            <th class="px-4 py-3 text-right">Desde</th>
            <th class="px-4 py-3 text-center">Destacado</th>
            <th class="px-4 py-3 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="p in items"
            :key="p.id"
            class="border-b border-slate-100 last:border-0 hover:bg-slate-50"
            :class="{ 'opacity-50': !p.active }"
          >
            <td class="px-4 py-2.5">
              <div class="flex items-center gap-3">
                <div class="w-10 shrink-0"><ProductVisual :visual="p.visual" /></div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <NuxtLink
                      :to="`/admin/productos/${p.id}`"
                      class="block truncate font-medium text-slate-800 hover:text-neteco-600"
                    >
                      {{ p.name }}
                    </NuxtLink>
                    <UBadge :color="p.active ? 'success' : 'neutral'" variant="subtle" size="sm">
                      {{ STATUS_LABELS[p.status] }}
                    </UBadge>
                  </div>
                  <p class="text-xs text-slate-500">
                    {{ p.brand }}<template v-if="p.series"> · gama {{ p.series }}</template>
                  </p>
                </div>
              </div>
            </td>
            <td class="px-4 py-2.5 text-slate-600">{{ p.categoryName }}</td>
            <td class="px-4 py-2.5 text-center text-slate-600">{{ p.formats }}</td>
            <td class="px-4 py-2.5 text-right font-medium text-slate-800">{{ formatPrice(p.minPrice) }}</td>
            <td class="px-4 py-2.5 text-center">
              <UIcon v-if="p.featured" name="i-lucide-star" class="size-4 text-amber-500" />
            </td>
            <td class="px-4 py-2.5">
              <div class="flex justify-end gap-1">
                <select
                  :value="p.status"
                  :aria-label="`Cambiar estado de ${p.name}`"
                  class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                  @change="changeStatus(p, ($event.target as HTMLSelectElement).value as AdminProductSummary['status'])"
                >
                  <option :value="p.status">{{ STATUS_LABELS[p.status] }}</option>
                  <option v-for="status in STATUS_TRANSITIONS[p.status]" :key="status" :value="status">
                    → {{ STATUS_LABELS[status] }}
                  </option>
                </select>
                <UButton
                  v-if="p.active"
                  :to="`/producto/${p.slug}`"
                  target="_blank"
                  size="xs"
                  variant="ghost"
                  icon="i-lucide-external-link"
                  aria-label="Ver en la tienda"
                />
                <UButton
                  :to="`/admin/productos/${p.id}`"
                  size="xs"
                  variant="soft"
                  icon="i-lucide-pencil"
                  aria-label="Editar"
                />
                <UButton
                  size="xs"
                  color="error"
                  variant="ghost"
                  icon="i-lucide-trash-2"
                  aria-label="Eliminar"
                  @click="removeProduct(p)"
                />
              </div>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="6" class="px-4 py-10 text-center text-slate-500">No hay productos con ese filtro.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
