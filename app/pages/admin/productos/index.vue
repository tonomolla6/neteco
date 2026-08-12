<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Productos · Admin' })

const q = ref('')
const category = ref('')
const estado = ref('')

const { data: catData } = await useFetch('/api/categories', { key: 'categories' })
const catOptions = computed(() => flattenCategoryTree((catData.value as any)?.roots ?? []))

const { data, refresh } = await useFetch('/api/admin/products', { query: { q, category, active: estado } })
const items = computed(() => (data.value as any)?.items ?? [])

const toast = useToast()

async function toggleActive(p: any) {
  try {
    await $fetch(`/api/admin/products/${p.id}/active`, { method: 'PUT', body: { active: !p.active } })
    toast.add({
      title: p.active ? `«${p.name}» oculto de la tienda` : `«${p.name}» publicado en la tienda`,
      icon: p.active ? 'i-lucide-eye-off' : 'i-lucide-eye',
      color: 'success'
    })
    refresh()
    refreshNuxtData('categories')
  } catch (e: any) {
    toast.add({
      title: e?.data?.statusMessage ?? 'No se ha podido cambiar el estado',
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  }
}

async function removeProduct(p: any) {
  if (!confirm(`¿Eliminar «${p.name}» y sus ${p.formats} variante(s)? Esta acción no se puede deshacer.`)) return
  try {
    await $fetch(`/api/admin/products/${p.id}`, { method: 'DELETE' })
    toast.add({ title: 'Producto eliminado', icon: 'i-lucide-trash-2', color: 'success' })
    refresh()
    refreshNuxtData('categories')
  } catch (e: any) {
    toast.add({
      title: e?.data?.statusMessage ?? 'No se ha podido eliminar',
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
        <option value="">Publicados y ocultos</option>
        <option value="1">Solo publicados</option>
        <option value="0">Solo ocultos</option>
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
                    <UBadge v-if="!p.active" color="neutral" variant="subtle" size="sm">Oculto</UBadge>
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
                <UButton
                  size="xs"
                  :variant="p.active ? 'ghost' : 'soft'"
                  :color="p.active ? 'neutral' : 'success'"
                  :icon="p.active ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  :aria-label="p.active ? 'Ocultar de la tienda' : 'Publicar en la tienda'"
                  @click="toggleActive(p)"
                />
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
