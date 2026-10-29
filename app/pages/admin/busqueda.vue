<script setup lang="ts">
import AdminSearchMerchandisingRules from '../../components/AdminSearchMerchandisingRules.vue'
import SearchSynonymsPanel from '../../components/SearchSynonymsPanel.vue'
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Relevancia de búsqueda' })
const runtime = useRuntimeConfig().public.serverRuntime

/**
 * Sinónimos de búsqueda.
 *
 * La pantalla vacía era una tabla con una fila que decía «No hay sinónimos configurados»
 * y el 80 % de la pantalla en blanco. El problema es que sin un ejemplo nadie sabe para
 * qué sirve esto: el estado vacío ahora lo explica y ofrece un punto de partida real del
 * sector —«lejía» → «hipoclorito, cloro»—, que es la clase de vocabulario que separa a un
 * cliente de hostelería del catálogo técnico.
 */
interface SynonymItem {
  id: string
  sourceTerm: string
  replacements: string[]
  active: boolean
  updatedAt: string
}

const {
  data,
  refresh,
  status: fetchStatus
} = await useFetch<{ items: SynonymItem[] }>('/api/admin/search-synonyms', {
  immediate: runtime === 'node',
  server: runtime === 'node'
})
const items = computed(() => data.value?.items ?? [])
const toast = useToast()
const saving = ref(false)

const creating = ref(false)
const sourceTerm = ref('')
const replacements = ref('')

const EJEMPLOS = [
  { term: 'lejía', to: 'hipoclorito, cloro' },
  { term: 'papel higiénico', to: 'celulosa, higiénico industrial' },
  { term: 'estropajo', to: 'fibra, salvauñas' }
]

function usarEjemplo(ejemplo: (typeof EJEMPLOS)[number]) {
  sourceTerm.value = ejemplo.term
  replacements.value = ejemplo.to
  creating.value = true
}

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
      body: { sourceTerm: sourceTerm.value.trim(), replacements: values }
    })
    sourceTerm.value = ''
    replacements.value = ''
    creating.value = false
    await refresh()
    toast.add({ title: 'Sinónimo añadido', color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido añadir'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggle(item: SynonymItem) {
  try {
    await $fetch(`/api/admin/search-synonyms/${item.id}`, {
      method: 'PUT',
      body: { sourceTerm: item.sourceTerm, replacements: item.replacements, active: !item.active }
    })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cambiar el estado'), color: 'error' })
  }
}

const removing = ref<SynonymItem | null>(null)

async function confirmRemove() {
  const item = removing.value
  if (!item) return
  saving.value = true
  try {
    await $fetch(`/api/admin/search-synonyms/${item.id}`, { method: 'DELETE' })
    removing.value = null
    await refresh()
    toast.add({ title: 'Sinónimo eliminado', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido eliminar'), color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="runtime === 'cloudflare'" class="space-y-8">
    <SearchSynonymsPanel :runtime="runtime" />
    <AdminSearchMerchandisingRules :runtime="runtime" />
  </div>
  <div v-else-if="runtime === 'node'" class="mx-auto max-w-4xl">
    <UiPageHeader
      title="Relevancia de búsqueda"
      :count="items.length"
      :count-label="items.length === 1 ? 'sinónimo' : 'sinónimos'"
      description="Cuando un cliente busca con sus palabras y el catálogo usa otras, esto las conecta. No cambia el catálogo: solo amplía la consulta."
    >
      <template #actions>
        <UButton icon="i-lucide-plus" @click="creating = true">Añadir sinónimo</UButton>
      </template>
    </UiPageHeader>

    <UiSurface padding="none">
      <div v-if="fetchStatus === 'pending'" class="divide-y divide-[var(--border)]">
        <div v-for="n in 3" :key="n" class="px-4 py-4">
          <div class="h-4 w-1/2 animate-pulse rounded bg-[var(--surface-sunken)]" />
        </div>
      </div>

      <div v-else-if="!items.length" class="px-6 py-12 text-center">
        <div class="mx-auto flex size-12 items-center justify-center rounded-full bg-[var(--surface-sunken)]">
          <UIcon name="i-lucide-search-check" class="size-6 text-[var(--text-muted)]" />
        </div>
        <p class="mt-4 font-semibold text-[var(--text-strong)]">Todavía no hay sinónimos</p>
        <p class="mx-auto mt-1.5 max-w-lg text-sm text-[var(--text-muted)]">
          Un cliente busca «lejía» y el catálogo la llama «hipoclorito»: sin un sinónimo, no encuentra nada y se va.
          Empieza por los términos que la gente usa de verdad al pedir por teléfono.
        </p>
        <div class="mt-5 flex flex-wrap justify-center gap-2">
          <UButton
            v-for="ejemplo in EJEMPLOS"
            :key="ejemplo.term"
            size="sm"
            color="neutral"
            variant="outline"
            @click="usarEjemplo(ejemplo)"
          >
            {{ ejemplo.term }} → {{ ejemplo.to }}
          </UButton>
        </div>
      </div>

      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="item in items" :key="item.id" class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div class="min-w-0 flex-1">
            <p class="font-medium text-[var(--text-strong)]">
              {{ item.sourceTerm }}
              <UIcon name="i-lucide-arrow-right" class="mx-1 size-3.5 align-middle text-[var(--text-muted)]" />
              <span class="font-normal text-[var(--text)]">{{ item.replacements.join(', ') }}</span>
            </p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">
              Actualizado el {{ new Date(item.updatedAt).toLocaleDateString('es-ES') }}
            </p>
          </div>
          <UBadge :color="item.active ? 'success' : 'neutral'" variant="subtle">
            {{ item.active ? 'Activo' : 'Pausado' }}
          </UBadge>
          <div class="flex gap-1">
            <UButton size="xs" color="neutral" variant="outline" @click="toggle(item)">
              {{ item.active ? 'Pausar' : 'Activar' }}
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :aria-label="`Eliminar ${item.sourceTerm}`"
              @click="removing = item"
            />
          </div>
        </li>
      </ul>
    </UiSurface>

    <UModal v-model:open="creating" title="Añadir sinónimo">
      <template #body>
        <form id="synonym-form" class="space-y-4" @submit.prevent="create">
          <UFormField label="Lo que escribe el cliente" required>
            <UInput v-model="sourceTerm" class="w-full" placeholder="lejía" />
          </UFormField>
          <UFormField label="Con qué se busca además" required hint="Separa los términos con comas">
            <UInput v-model="replacements" class="w-full" placeholder="hipoclorito, cloro" />
          </UFormField>
          <p class="text-sm text-[var(--text-muted)]">
            Al buscar el primer término, la tienda buscará también los demás. No modifica los nombres del catálogo.
          </p>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="creating = false">Cancelar</UButton>
          <UButton type="submit" form="synonym-form" :loading="saving">Añadir</UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(removing)" title="Eliminar sinónimo" @update:open="(value) => !value && (removing = null)">
      <template #body>
        <p class="text-[var(--text)]">
          Quien busque <strong>{{ removing?.sourceTerm }}</strong> dejará de encontrar los resultados de
          <strong>{{ removing?.replacements.join(', ') }}</strong
          >.
        </p>
        <p class="mt-3 text-sm text-[var(--text-muted)]">
          Si solo quieres probar sin perderlo, púsalo en lugar de eliminarlo.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">Cancelar</UButton>
          <UButton color="error" :loading="saving" @click="confirmRemove">Eliminar</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
