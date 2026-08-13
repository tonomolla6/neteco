<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Relevancia de búsqueda' })

interface SynonymItem {
  id: string
  sourceTerm: string
  replacements: string[]
  active: boolean
  updatedAt: string
}

const { data, refresh } = await useFetch<{ items: SynonymItem[] }>('/api/admin/search-synonyms')
const items = computed(() => data.value?.items ?? [])
const sourceTerm = ref('')
const replacements = ref('')
const saving = ref(false)
const toast = useToast()

async function create() {
  const values = replacements.value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!sourceTerm.value.trim() || !values.length) return
  saving.value = true
  try {
    await $fetch('/api/admin/search-synonyms', {
      method: 'POST',
      body: { sourceTerm: sourceTerm.value, replacements: values }
    })
    sourceTerm.value = ''
    replacements.value = ''
    await refresh()
    toast.add({ title: 'Sinónimo añadido', color: 'success' })
  } finally {
    saving.value = false
  }
}

async function toggle(item: SynonymItem) {
  await $fetch(`/api/admin/search-synonyms/${item.id}`, {
    method: 'PUT',
    body: { sourceTerm: item.sourceTerm, replacements: item.replacements, active: !item.active }
  })
  await refresh()
}

async function remove(item: SynonymItem) {
  if (!window.confirm(`Eliminar el sinónimo «${item.sourceTerm}»?`)) return
  await $fetch(`/api/admin/search-synonyms/${item.id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Relevancia de búsqueda</h1>
        <p class="mt-1 text-sm text-slate-500">Vocabulario revisado que amplía consultas sin alterar el catálogo.</p>
      </div>
    </div>

    <form
      class="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 md:grid-cols-3"
      @submit.prevent="create"
    >
      <UFormField label="Término del cliente"
        ><UInput v-model="sourceTerm" class="w-full" placeholder="lejía"
      /></UFormField>
      <UFormField label="Equivalentes separados por coma" class="md:col-span-2">
        <div class="flex gap-2">
          <UInput v-model="replacements" class="flex-1" placeholder="hipoclorito, cloro" />
          <UButton type="submit" :loading="saving">Añadir</UButton>
        </div>
      </UFormField>
    </form>

    <div class="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <table class="w-full text-left text-sm">
        <thead class="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            <th class="px-4 py-3">Consulta</th>
            <th class="px-4 py-3">Expande a</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3"><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          <tr v-for="item in items" :key="item.id">
            <td class="px-4 py-3 font-medium text-slate-800">{{ item.sourceTerm }}</td>
            <td class="px-4 py-3 text-slate-600">{{ item.replacements.join(', ') }}</td>
            <td class="px-4 py-3">
              <UBadge :color="item.active ? 'success' : 'neutral'">{{ item.active ? 'Activo' : 'Pausado' }}</UBadge>
            </td>
            <td class="px-4 py-3 text-right">
              <UButton size="xs" variant="ghost" color="neutral" @click="toggle(item)">{{
                item.active ? 'Pausar' : 'Activar'
              }}</UButton>
              <UButton size="xs" variant="ghost" color="error" @click="remove(item)">Eliminar</UButton>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="4" class="px-4 py-8 text-center text-slate-500">No hay sinónimos configurados.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
