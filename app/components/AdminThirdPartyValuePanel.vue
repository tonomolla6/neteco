<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Script {
  id: string
  vendor: string
  name: string
  kind: string
  monthlyCostCents: number
  loadMsP75: number
  status: 'active' | 'removed'
  version: number
  latestVerdict: 'keep' | 'remove' | 'inconclusive' | null
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const scripts = ref<Script[]>([])
const reasons = ref<Record<string, string>>({})
const form = ref({ vendor: '', name: '', kind: 'pixel', monthlyCostEur: 0, loadMsP75: 0 })

const verdictLabel: Record<string, string> = {
  keep: 'Mantener',
  remove: 'Eliminar: no compensa',
  inconclusive: 'Sin conclusión todavía'
}
const kindLabel: Record<string, string> = {
  pixel: 'Píxel de seguimiento',
  widget: 'Complemento visual',
  analytics: 'Analítica',
  chat: 'Chat',
  ab_testing: 'Pruebas comparativas',
  other: 'Otro'
}
const errorLabel: Record<string, string> = {
  forbidden: 'No tienes permiso para gestionar los servicios externos.',
  version_conflict: 'Otra persona ha cambiado este servicio. Actualiza y vuelve a intentarlo.',
  validation_error: 'Revisa los datos: hay algún campo incompleto o no válido.'
}
// Estado de interfaz: panel lateral del alta.
const formOpen = ref(false)

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return (code && errorLabel[code]) || fallback
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    scripts.value =
      ((await requestFetch('/api/admin/performance/third-parties')) as { scripts: Script[] })?.scripts ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'No hemos podido cargar los servicios externos. Vuelve a intentarlo.')
  } finally {
    loading.value = false
  }
}

async function post(path: string, body: Record<string, unknown>, success: string) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await requestFetch(`/api/admin/performance/third-parties/${path}`, {
      method: 'POST',
      body: { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...body }
    })
    notice.value = success
    formOpen.value = false
    await load()
  } catch (error) {
    errorMessage.value = errorText(error, 'No hemos podido completar la operación. Vuelve a intentarlo.')
  } finally {
    busy.value = false
  }
}

const register = () =>
  post(
    'scripts',
    {
      vendor: form.value.vendor.trim(),
      name: form.value.name.trim(),
      kind: form.value.kind,
      monthlyCostCents: Math.round(Number(form.value.monthlyCostEur) * 100),
      loadMsP75: Math.round(Number(form.value.loadMsP75))
    },
    'Servicio añadido.'
  )
const remove = (script: Script) =>
  post(
    'remove',
    { scriptId: script.id, expectedVersion: script.version, reason: (reasons.value[script.id] ?? '').trim() },
    'Servicio retirado de la tienda.'
  )

onMounted(load)
</script>

<template>
  <section class="adm-stack" aria-label="Servicios externos: valor frente a coste" data-third-party-panel>
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="formOpen = true">Añadir servicio</AdminButton>
    </AdminPageActions>

    <div v-if="errorMessage" role="alert" data-error>
      <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="errorMessage">
        <template #actions>
          <button type="button" class="adm-btn adm-btn--secondary adm-btn--sm" data-retry @click="load">
            Reintentar
          </button>
        </template>
      </UAlert>
    </div>
    <div v-if="notice" role="status">
      <UAlert color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    </div>

    <p class="adm-help">
      Cada servicio de otra empresa que se carga en la tienda (píxeles, chat, analítica…) la hace más lenta. Se compara
      la tienda con y sin él: si no aporta ventas, se retira.
    </p>

    <AdminCard flush>
      <div v-if="loading" class="adm-table-skeleton" aria-busy="true" data-loading>
        <span class="sr-only">Cargando servicios externos…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
      </div>
      <div v-else-if="!scripts.length && !errorMessage" data-empty>
        <AdminEmptyState
          compact
          icon="i-lucide-plug"
          title="No hay servicios externos registrados"
          description="Añade los píxeles, chats o herramientas de analítica que carga la tienda para medir si compensan."
        >
          <AdminButton icon="i-lucide-plus" @click="formOpen = true">Añadir servicio</AdminButton>
        </AdminEmptyState>
      </div>
      <ul v-else class="adm-list">
        <li v-for="s in scripts" :key="s.id" data-script>
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              {{ s.vendor }} · {{ s.name }}
              <AdminBadge v-if="s.status === 'removed'" tone="neutral" data-removed>Retirado</AdminBadge>
              <AdminBadge
                v-else-if="s.latestVerdict"
                :tone="s.latestVerdict === 'remove' ? 'danger' : s.latestVerdict === 'keep' ? 'success' : 'neutral'"
                data-verdict
              >
                {{ verdictLabel[s.latestVerdict] }}
              </AdminBadge>
              <AdminBadge v-else tone="neutral">Sin medir todavía</AdminBadge>
            </p>
            <p class="adm-help">
              {{ kindLabel[s.kind] ?? adminHumanize(s.kind) }} · {{ adminMoney(s.monthlyCostCents) }} al mes · tarda
              {{ s.loadMsP75 }} ms en cargar
            </p>
          </div>
          <div v-if="s.status === 'active'" class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <input
              v-model="reasons[s.id]"
              :aria-label="`Motivo para eliminar ${s.name}`"
              placeholder="Motivo (mín. 10 caracteres)"
              maxlength="500"
              class="adm-input min-w-0 flex-1 sm:w-64"
            />
            <button
              type="button"
              class="adm-btn adm-btn--danger-soft"
              :disabled="busy || (reasons[s.id] ?? '').trim().length < 10"
              data-remove
              @click="remove(s)"
            >
              Eliminar
            </button>
          </div>
        </li>
      </ul>
    </AdminCard>

    <AdminDrawer
      v-model:open="formOpen"
      title="Añadir servicio externo"
      description="Registra un servicio de otra empresa que se carga en la tienda."
    >
      <form id="third-party-form" class="adm-stack" @submit.prevent="register">
        <AdminFormField v-slot="{ id }" label="Proveedor" required>
          <input :id="id" v-model="form.vendor" required minlength="2" maxlength="80" class="adm-input" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Nombre" required>
          <input :id="id" v-model="form.name" required minlength="2" maxlength="80" class="adm-input" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Tipo">
          <select :id="id" v-model="form.kind" class="adm-input">
            <option v-for="(label, key) in kindLabel" :key="key" :value="key">{{ label }}</option>
          </select>
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Coste mensual (€)">
          <input :id="id" v-model.number="form.monthlyCostEur" type="number" min="0" step="0.01" class="adm-input" />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="formOpen = false">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" form="third-party-form" :loading="busy">Guardar</AdminButton>
      </template>
    </AdminDrawer>
  </section>
</template>
