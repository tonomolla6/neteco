<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { developerServices } from '~~/shared/developer-portal-catalog'
const requestFetch = useRequestFetch()
type Owner = { serviceId: string; owner: string; version: number; updatedAt: string }
type Command = { serviceId: string; owner: string; expectedVersion: number }
const rows = ref<Owner[]>([])
const loading = ref(true)
const failed = ref(false)
const saving = ref(false)
const ambiguous = ref(false)
const serviceId = ref('catalog')
const owner = ref('')
const pending = ref<{ id: string; body: Command } | null>(null)
const selectedVersion = computed(() => rows.value.find((item) => item.serviceId === serviceId.value)?.version ?? 0)
async function load() {
  loading.value = true
  failed.value = false
  try {
    rows.value = (await requestFetch<{ items: Owner[] }>('/api/admin/developer-platform/ownership')).items
  } catch {
    rows.value = []
    failed.value = true
  } finally {
    loading.value = false
  }
}
async function send() {
  if (!pending.value || saving.value) return
  saving.value = true
  ambiguous.value = false
  try {
    await requestFetch('/api/admin/developer-platform/ownership', {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.value.id },
      body: pending.value.body
    })
    pending.value = null
    owner.value = ''
    await load()
  } catch {
    ambiguous.value = true
  } finally {
    saving.value = false
  }
}
function submit() {
  if (pending.value || saving.value || loading.value || failed.value) return
  pending.value = {
    id: crypto.randomUUID(),
    body: { serviceId: serviceId.value, owner: owner.value, expectedVersion: selectedVersion.value }
  }
  void send()
}
function abandon() {
  pending.value = null
  ambiguous.value = false
  void load()
}
onMounted(load)
</script>
<template>
  <AdminCard
    aria-labelledby="ownership-title"
    description="Indica el equipo que responde de cada servicio. Usa códigos de equipo, no nombres de personas ni datos de contacto."
  >
    <template #title><span id="ownership-title">Responsables de servicios</span></template>
    <div class="adm-stack">
      <p v-if="loading" role="status" class="adm-help">Cargando responsables…</p>
      <div v-else-if="failed" role="alert">
        <AdminEmptyState
          variant="error"
          compact
          title="No se pudieron cargar los responsables"
          description="Comprueba la conexión y vuelve a intentarlo."
        >
          <button type="button" class="adm-btn adm-btn--secondary" @click="load">Reintentar</button>
        </AdminEmptyState>
      </div>
      <ul v-else class="adm-list">
        <li v-for="service in developerServices" :key="service.id">
          <div class="min-w-0 flex-1">
            <p class="adm-list__title">{{ service.name }}</p>
          </div>
          <AdminBadge :tone="rows.find((item) => item.serviceId === service.id) ? 'info' : 'neutral'" plain>
            {{ rows.find((item) => item.serviceId === service.id)?.owner ?? 'Sin responsable asignado' }}
          </AdminBadge>
        </li>
      </ul>
      <UAlert
        v-if="ambiguous"
        role="alert"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        title="No sabemos si el cambio se guardó"
        description="El resultado desconocido requiere revisión. Puedes reintentar la misma operación o recargar antes de hacer otro cambio."
      >
        <template #actions>
          <button
            type="button"
            class="adm-btn adm-btn--secondary adm-btn--sm"
            data-retry-owner
            :disabled="saving"
            @click="send"
          >
            Reintentar operación
          </button>
          <button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" :disabled="saving" @click="abandon">
            Cerrar operación y recargar
          </button>
        </template>
      </UAlert>
      <form @submit.prevent="submit">
        <fieldset :disabled="loading || failed || !!pending || saving" class="adm-stack">
          <legend class="adm-label">Asignar responsable</legend>
          <div class="adm-form-grid">
            <div class="adm-field">
              <label for="developer-service" class="adm-label">Servicio</label>
              <select id="developer-service" v-model="serviceId" class="adm-input">
                <option v-for="service in developerServices" :key="service.id" :value="service.id">
                  {{ service.name }}
                </option>
              </select>
            </div>
            <div class="adm-field">
              <label for="developer-owner" class="adm-label">Código de equipo</label>
              <input
                id="developer-owner"
                v-model="owner"
                class="adm-input"
                type="text"
                pattern="[a-z][a-z0-9._-]{1,63}"
                maxlength="64"
                required
                aria-describedby="developer-owner-help"
              />
              <p id="developer-owner-help" class="adm-help">
                En minúsculas, sin espacios. Por ejemplo: operaciones.tienda
              </p>
            </div>
          </div>
          <div>
            <button type="submit" class="adm-btn adm-btn--secondary">Guardar responsable</button>
          </div>
        </fieldset>
      </form>
    </div>
  </AdminCard>
</template>
