<script setup lang="ts">
import AdminSearchMerchandisingRules from '../../components/AdminSearchMerchandisingRules.vue'
import SearchSynonymsPanel from '../../components/SearchSynonymsPanel.vue'
import AdminSemanticSearchEvaluation from '../../components/AdminSemanticSearchEvaluation.vue'
import AdminPersonalizedRerankUplift from '../../components/AdminPersonalizedRerankUplift.vue'
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
const confirmingRemove = computed({
  get: () => removing.value !== null,
  set: (open: boolean) => {
    if (!open) removing.value = null
  }
})

/** Apartados de la pantalla: cada uno conserva su estado aunque se cambie de pestaña. */
const TABS = [
  { value: 'sinonimos', label: 'Sinónimos' },
  { value: 'reglas', label: 'Reglas de resultados' },
  { value: 'calidad', label: 'Calidad de resultados' },
  { value: 'personalizacion', label: 'Orden personalizado' }
]
const activeTab = ref('sinonimos')

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
  <AdminPage
    :count="runtime === 'node' ? items.length : undefined"
    :count-label="items.length === 1 ? 'sinónimo' : 'sinónimos'"
  >
    <template v-if="runtime === 'node'" #actions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="creating = true">Añadir sinónimo</AdminButton>
    </template>
    <div v-if="runtime === 'cloudflare'" class="adm-stack">
      <AdminTabs v-model="activeTab" :tabs="TABS" label="Apartados de búsqueda" />
      <SearchSynonymsPanel v-show="activeTab === 'sinonimos'" :runtime="runtime" />
      <AdminSearchMerchandisingRules v-show="activeTab === 'reglas'" :runtime="runtime" />
      <AdminSemanticSearchEvaluation v-show="activeTab === 'calidad'" :runtime="runtime" />
      <AdminPersonalizedRerankUplift v-show="activeTab === 'personalizacion'" :runtime="runtime" />
    </div>
    <div v-else-if="runtime === 'node'" class="adm-stack">
      <AdminCard flush>
        <div v-if="fetchStatus === 'pending'" class="adm-table-skeleton" aria-busy="true">
          <span class="sr-only">Cargando…</span>
          <div v-for="n in 3" :key="n"><i /><i /><i /></div>
        </div>

        <AdminEmptyState
          v-else-if="fetchStatus === 'error'"
          variant="error"
          title="No se han podido cargar los sinónimos"
          description="Puede ser un fallo puntual de conexión. Vuelve a intentarlo."
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="refresh()">Reintentar</AdminButton>
        </AdminEmptyState>

        <AdminEmptyState
          v-else-if="!items.length"
          icon="i-lucide-search-check"
          title="Todavía no hay sinónimos"
          description="Un cliente busca «lejía» y el catálogo la llama «hipoclorito»: sin un sinónimo, no encuentra nada y se va. Empieza por las palabras que la gente usa de verdad al pedir por teléfono."
        >
          <AdminButton v-for="ejemplo in EJEMPLOS" :key="ejemplo.term" size="sm" @click="usarEjemplo(ejemplo)">
            {{ ejemplo.term }} → {{ ejemplo.to }}
          </AdminButton>
        </AdminEmptyState>

        <ul v-else class="adm-list">
          <li v-for="item in items" :key="item.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ item.sourceTerm }}
                <UIcon name="i-lucide-arrow-right" class="mx-1 size-3.5 align-middle text-[var(--text-muted)]" />
                <span class="font-normal text-[var(--text)]">{{ item.replacements.join(', ') }}</span>
              </p>
              <p class="adm-help">Actualizado el {{ adminDate(item.updatedAt) }}</p>
            </div>
            <AdminBadge :tone="item.active ? 'success' : 'neutral'">
              {{ item.active ? 'Activo' : 'En pausa' }}
            </AdminBadge>
            <AdminButton size="sm" @click="toggle(item)">{{ item.active ? 'Pausar' : 'Activar' }}</AdminButton>
            <AdminButton
              size="sm"
              variant="danger-soft"
              icon="i-lucide-trash-2"
              :label="`Eliminar ${item.sourceTerm}`"
              @click="removing = item"
            />
          </li>
        </ul>
      </AdminCard>

      <AdminDrawer v-model:open="creating" title="Añadir sinónimo">
        <form id="synonym-form" class="adm-stack" @submit.prevent="create">
          <AdminFormField v-slot="{ id }" label="Lo que escribe el cliente" required>
            <input :id="id" v-model="sourceTerm" type="text" placeholder="lejía" />
          </AdminFormField>
          <AdminFormField
            v-slot="{ id }"
            label="Con qué se busca además"
            help="Separa las palabras con comas."
            required
          >
            <input :id="id" v-model="replacements" type="text" placeholder="hipoclorito, cloro" />
          </AdminFormField>
          <p class="adm-help">
            Al buscar la primera palabra, la tienda buscará también las demás. No cambia los nombres del catálogo.
          </p>
        </form>
        <template #footer>
          <AdminButton @click="creating = false">Cancelar</AdminButton>
          <AdminButton variant="primary" type="submit" form="synonym-form" :loading="saving">Añadir</AdminButton>
        </template>
      </AdminDrawer>

      <AdminConfirm
        v-model:open="confirmingRemove"
        title="Eliminar sinónimo"
        confirm-label="Eliminar"
        danger
        :loading="saving"
        @confirm="confirmRemove"
      >
        <p>
          Quien busque <strong>{{ removing?.sourceTerm }}</strong> dejará de encontrar los resultados de
          <strong>{{ removing?.replacements.join(', ') }}</strong
          >.
        </p>
        <p class="adm-help mt-3">Si solo quieres probar sin perderlo, ponlo en pausa en lugar de eliminarlo.</p>
      </AdminConfirm>
    </div>
  </AdminPage>
</template>
