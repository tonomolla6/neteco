<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Rule {
  id: string
  slot: string
  segment: 'b2c_new' | 'b2c_returning' | 'b2b'
  variantKey: string
  status: 'draft' | 'enabled' | 'disabled'
  version: number
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const rules = ref<Rule[]>([])
const form = ref({ slot: '', segment: 'b2b', variantKey: '' })
const evidence = ref<Record<string, Record<string, number>>>({})
const segmentLabel: Record<string, string> = {
  b2c_new: 'Particular nuevo',
  b2c_returning: 'Particular que repite',
  b2b: 'Profesional'
}
const statusLabel: Record<Rule['status'], string> = { draft: 'Borrador', enabled: 'Activa', disabled: 'Desactivada' }
const statusTone = { draft: 'neutral', enabled: 'success', disabled: 'neutral' } as const
const errorLabel: Record<string, string> = {
  forbidden: 'No tienes permiso para gestionar estas reglas.',
  version_conflict: 'Otra persona ha cambiado esta regla. Actualiza y vuelve a intentarlo.',
  validation_error: 'Revisa los datos: hay algún campo incompleto o no válido.',
  invalid_evidence: 'Los datos de la prueba no son coherentes. Revísalos.'
}
const reasonLabel: Record<string, string> = {
  insufficient_sample: 'la prueba aún tiene pocos visitantes',
  not_significant: 'la diferencia de ventas no es concluyente',
  lift_below_minimum: 'la mejora de ventas es demasiado pequeña',
  lcp_regression: 'la página carga más lenta con esta variante',
  cache_hit_rate_drop: 'se sirven menos páginas al instante'
}
// Estado de interfaz: panel lateral del alta.
const formOpen = ref(false)

function errorText(error: unknown, fallback: string): string {
  const data = (error as { data?: { error?: { code?: string; message?: string } } })?.data?.error
  if (data?.code === 'evidence_insufficient') {
    const reasons = (data.message ?? '')
      .split(',')
      .map((reason) => reasonLabel[reason.trim()])
      .filter(Boolean)
    return reasons.length
      ? `No se puede activar todavía: ${reasons.join(', ')}.`
      : 'No se puede activar todavía: los resultados de la prueba no son suficientes.'
  }
  return (data?.code && errorLabel[data.code]) || fallback
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    rules.value =
      ((await requestFetch('/api/admin/performance/edge-personalization/rules')) as { rules: Rule[] })?.rules ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'No hemos podido cargar las reglas. Vuelve a intentarlo.')
  } finally {
    loading.value = false
  }
}

async function post(path: string, body: Record<string, unknown>, success: string) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await requestFetch(`/api/admin/performance/edge-personalization/${path}`, {
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

const createRule = () =>
  post(
    'rules',
    { slot: form.value.slot.trim(), segment: form.value.segment, variantKey: form.value.variantKey.trim() },
    'Regla creada en borrador.'
  )
const enable = (r: Rule) => post('rules/enable', { ruleId: r.id, expectedVersion: r.version }, 'Regla activada.')
const disable = (r: Rule) =>
  post(
    'rules/disable',
    { ruleId: r.id, expectedVersion: r.version },
    'Regla desactivada: se vuelve a mostrar el contenido habitual.'
  )
function saveEvidence(r: Rule) {
  const e = evidence.value[r.id] ?? {}
  return post(
    'rules/evidence',
    {
      ruleId: r.id,
      controlVisitors: Number(e.controlVisitors ?? 0),
      controlConversions: Number(e.controlConversions ?? 0),
      treatmentVisitors: Number(e.treatmentVisitors ?? 0),
      treatmentConversions: Number(e.treatmentConversions ?? 0),
      lcpDeltaMs: Number(e.lcpDeltaMs ?? 0),
      cacheHitRateBps: Number(e.cacheHitRateBps ?? 0),
      baselineCacheHitRateBps: Number(e.baselineCacheHitRateBps ?? 0)
    },
    'Resultados de la prueba guardados.'
  )
}
const fields: Array<[string, string]> = [
  ['controlVisitors', 'Visitantes sin la variante'],
  ['controlConversions', 'Pedidos sin la variante'],
  ['treatmentVisitors', 'Visitantes con la variante'],
  ['treatmentConversions', 'Pedidos con la variante'],
  ['lcpDeltaMs', 'Cambio en el tiempo de carga (ms)'],
  ['cacheHitRateBps', 'Páginas al instante con la regla (‱)'],
  ['baselineCacheHitRateBps', 'Páginas al instante sin la regla (‱)']
]

onMounted(load)
</script>

<template>
  <section class="adm-stack" aria-label="Contenido según el tipo de cliente" data-edge-panel>
    <AdminPageActions>
      <AdminButton variant="primary" icon="i-lucide-plus" @click="formOpen = true">Nueva regla</AdminButton>
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
      Muestra un contenido distinto a particulares nuevos, particulares que repiten o profesionales, sin usar datos
      personales y solo con su consentimiento. Una regla se activa únicamente si una prueba demuestra que vende más sin
      hacer la tienda más lenta; si algo falla, se muestra el contenido habitual.
    </p>

    <AdminCard flush>
      <div v-if="loading" class="adm-table-skeleton" aria-busy="true" data-loading>
        <span class="sr-only">Cargando reglas…</span>
        <div v-for="row in 3" :key="row"><i /><i /><i /><i /></div>
      </div>
      <div v-else-if="!rules.length && !errorMessage" data-empty>
        <AdminEmptyState
          compact
          icon="i-lucide-users"
          title="No hay reglas todavía"
          description="Crea una regla para mostrar un contenido distinto a un tipo de cliente."
        >
          <AdminButton icon="i-lucide-plus" @click="formOpen = true">Nueva regla</AdminButton>
        </AdminEmptyState>
      </div>
      <ul v-else class="adm-list">
        <li v-for="r in rules" :key="r.id" data-rule>
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">
              {{ adminHumanize(r.slot) }}
              <AdminBadge :tone="statusTone[r.status]" data-status>{{ statusLabel[r.status] }}</AdminBadge>
            </p>
            <p class="adm-help">{{ segmentLabel[r.segment] }} → variante «{{ adminHumanize(r.variantKey) }}»</p>
          </div>
          <button
            v-if="r.status === 'enabled'"
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy"
            data-disable
            @click="disable(r)"
          >
            Desactivar
          </button>
          <button
            v-else
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            :disabled="busy"
            title="Solo se activa si los resultados de la prueba lo respaldan"
            data-enable
            @click="enable(r)"
          >
            Activar
          </button>
          <details v-if="r.status !== 'enabled'" class="w-full">
            <summary>Anotar los resultados de la prueba</summary>
            <div class="adm-form-grid mt-3">
              <label v-for="[key, label] in fields" :key="key" class="adm-label">
                {{ label }}
                <input v-model.number="(evidence[r.id] ??= {})[key]" type="number" class="adm-input mt-1" />
              </label>
            </div>
            <p class="adm-help mt-2">‱ = diezmilésimas: 9000 equivale al 90 %.</p>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm mt-3"
              :disabled="busy"
              data-save-evidence
              @click="saveEvidence(r)"
            >
              Guardar resultados
            </button>
          </details>
        </li>
      </ul>
    </AdminCard>

    <AdminDrawer
      v-model:open="formOpen"
      title="Nueva regla"
      description="Se crea como borrador: no se muestra a nadie hasta que la actives."
    >
      <form id="edge-rule-form" class="adm-stack" @submit.prevent="createRule">
        <AdminFormField
          v-slot="{ id }"
          label="Zona de la tienda"
          help="Identificador de la zona, en minúsculas y sin espacios. Ejemplo: home_hero"
          required
        >
          <input
            :id="id"
            v-model="form.slot"
            required
            pattern="[a-z][a-z0-9_]{1,39}"
            placeholder="home_hero"
            class="adm-input"
          />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Tipo de cliente">
          <select :id="id" v-model="form.segment" class="adm-input">
            <option v-for="(label, key) in segmentLabel" :key="key" :value="key">{{ label }}</option>
          </select>
        </AdminFormField>
        <AdminFormField
          v-slot="{ id }"
          label="Variante"
          help="Identificador del contenido alternativo. Ejemplo: bulk_offer"
          required
        >
          <input
            :id="id"
            v-model="form.variantKey"
            required
            pattern="[a-z][a-z0-9_]{1,39}"
            placeholder="bulk_offer"
            class="adm-input"
          />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="formOpen = false">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" form="edge-rule-form" :loading="busy">Crear borrador</AdminButton>
      </template>
    </AdminDrawer>
  </section>
</template>
