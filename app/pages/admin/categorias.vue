<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Familias · Admin' })

const { data: catData } = await useFetch('/api/categories', { key: 'categories' })

interface Row {
  id: number
  name: string
  count: number
  depth: number
  hasChildren: boolean
}
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (nodes: any[], depth: number) => {
    for (const n of nodes ?? []) {
      out.push({ id: n.id, name: n.name, count: n.count, depth, hasChildren: !!n.children?.length })
      walk(n.children, depth + 1)
    }
  }
  walk((catData.value as any)?.roots ?? [], 0)
  return out
})

// nombres editables en línea
const names = reactive<Record<number, string>>({})
watch(rows, (rs) => rs.forEach((r) => (names[r.id] = names[r.id] ?? r.name)), { immediate: true })

const newName = ref('')
const newParent = ref<number | null>(null)
const parentOptions = computed(() => flattenCategoryTree((catData.value as any)?.roots ?? []))

const toast = useToast()

async function createCategory() {
  if (!newName.value.trim()) return
  try {
    await $fetch('/api/admin/categories', {
      method: 'POST',
      body: { name: newName.value.trim(), parentId: newParent.value }
    })
    toast.add({ title: 'Familia creada', icon: 'i-lucide-check', color: 'success' })
    newName.value = ''
    await refreshNuxtData('categories')
  } catch (e: any) {
    toast.add({
      title: e?.data?.statusMessage ?? 'No se ha podido crear',
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  }
}

async function rename(row: Row) {
  const name = names[row.id]?.trim()
  if (!name || name === row.name) return
  try {
    await $fetch(`/api/admin/categories/${row.id}`, { method: 'PUT', body: { name } })
    toast.add({ title: 'Familia renombrada', icon: 'i-lucide-check', color: 'success' })
    await refreshNuxtData('categories')
  } catch (e: any) {
    toast.add({
      title: e?.data?.statusMessage ?? 'No se ha podido renombrar',
      color: 'error',
      icon: 'i-lucide-alert-circle'
    })
  }
}

async function removeCategory(row: Row) {
  if (!confirm(`¿Eliminar la familia «${row.name}»?`)) return
  try {
    await $fetch(`/api/admin/categories/${row.id}`, { method: 'DELETE' })
    toast.add({ title: 'Familia eliminada', icon: 'i-lucide-trash-2', color: 'success' })
    await refreshNuxtData('categories')
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
  <div class="mx-auto max-w-3xl">
    <h1 class="text-2xl font-bold text-slate-900">Familias de productos</h1>
    <p class="mt-1 text-sm text-slate-500">
      El árbol de la tienda: el menú, el catálogo y los filtros se generan a partir de estas familias. Los ids de las
      familias del ERP se conservan tal cual.
    </p>

    <!-- alta -->
    <form
      class="mt-5 flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white p-4"
      @submit.prevent="createCategory"
    >
      <UFormField label="Nueva familia" class="min-w-52 flex-1">
        <UInput v-model="newName" placeholder="Nombre de la familia" class="w-full" />
      </UFormField>
      <UFormField label="Dentro de">
        <select
          v-model="newParent"
          class="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
        >
          <option :value="null">— Raíz (familia principal) —</option>
          <option v-for="c in parentOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </UFormField>
      <UButton type="submit" icon="i-lucide-plus">Crear</UButton>
    </form>

    <!-- árbol -->
    <div class="mt-5 rounded-2xl border border-slate-200 bg-white">
      <div
        v-for="row in rows"
        :key="row.id"
        class="flex items-center gap-2 border-b border-slate-100 px-4 py-2 last:border-0"
        :style="{ paddingLeft: `${1 + row.depth * 1.5}rem` }"
      >
        <UIcon
          :name="row.hasChildren ? 'i-lucide-folder-tree' : 'i-lucide-folder'"
          class="size-4 shrink-0 text-neteco-600"
        />
        <input
          v-model="names[row.id]"
          class="min-w-0 flex-1 rounded-lg border border-transparent px-2 py-1 text-sm text-slate-800 hover:border-slate-200 focus:border-neteco-500 focus:outline-none"
          :aria-label="`Nombre de ${row.name}`"
          @keydown.enter.prevent="rename(row)"
        />
        <span class="shrink-0 text-xs text-slate-400">{{ row.count }} prod. · id {{ row.id }}</span>
        <UButton
          v-if="names[row.id]?.trim() && names[row.id] !== row.name"
          size="xs"
          variant="soft"
          icon="i-lucide-check"
          aria-label="Guardar nombre"
          @click="rename(row)"
        />
        <UButton
          size="xs"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          :disabled="row.hasChildren || row.count > 0"
          :aria-label="`Eliminar ${row.name}`"
          @click="removeCategory(row)"
        />
      </div>
    </div>
    <p class="mt-2 text-xs text-slate-400">Solo se pueden eliminar familias vacías (sin productos ni subfamilias).</p>
  </div>
</template>
