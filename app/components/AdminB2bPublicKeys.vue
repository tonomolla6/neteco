<script setup lang="ts">
import { onMounted, ref } from 'vue'
const requestFetch = useRequestFetch()
type Key = {
  id: string
  companyId?: string | null
  environment: string
  scopes: string
  quotaDaily: number
  status: string
  version: number
  createdAt: string
}
type Command =
  | { action: 'create'; environment: 'sandbox' | 'live'; scopes: string[]; quotaDaily: number; companyId?: string }
  | { action: 'revoke'; id: string; expectedVersion: number }
const items = ref<Key[]>([])
const page = ref(1)
const loading = ref(true)
const loadError = ref(false)
const saving = ref(false)
const ambiguous = ref(false)
const secret = ref<string | null>(null)
const message = ref('')
const environment = ref<'sandbox' | 'live'>('sandbox')
const read = ref(true)
const write = ref(false)
const quota = ref(100)
const companyId = ref('')
const pending = ref<{ id: string; body: Command } | null>(null)
async function load() {
  loading.value = true
  loadError.value = false
  try {
    const url = page.value === 1 ? '/api/admin/b2b-public/keys' : `/api/admin/b2b-public/keys?page=${page.value}`
    items.value = (await requestFetch<{ items: Key[] }>(url)).items
  } catch {
    loadError.value = true
    items.value = []
  } finally {
    loading.value = false
  }
}
async function send() {
  if (!pending.value || saving.value) return
  saving.value = true
  ambiguous.value = false
  secret.value = null
  message.value = ''
  try {
    const result = await requestFetch<{ id: string; key: string | null }>('/api/admin/b2b-public/keys', {
      method: 'POST',
      headers: { 'Idempotency-Key': pending.value.id },
      body: pending.value.body
    })
    if (pending.value.body.action === 'create') {
      secret.value = result.key
      message.value = result.key
        ? 'Copia la clave ahora; solo se muestra una vez.'
        : 'El secreto ya no está disponible. Revoca la clave y crea otra.'
    } else message.value = 'Clave revocada.'
    pending.value = null
    await load()
  } catch {
    ambiguous.value = true
  } finally {
    saving.value = false
  }
}
function create() {
  if (pending.value || saving.value || (!read.value && !write.value)) return
  const scopes = [read.value ? 'requests.read' : '', write.value ? 'requests.write' : ''].filter(Boolean)
  pending.value = {
    id: crypto.randomUUID(),
    body: {
      action: 'create',
      environment: environment.value,
      scopes,
      quotaDaily: Number(quota.value),
      ...(environment.value === 'live' ? { companyId: companyId.value.trim() } : {})
    }
  }
  void send()
}
function revoke(key: Key) {
  if (pending.value || saving.value) return
  pending.value = { id: crypto.randomUUID(), body: { action: 'revoke', id: key.id, expectedVersion: key.version } }
  void send()
}
function changePage(delta: number) {
  const next = page.value + delta
  if (
    loading.value ||
    pending.value ||
    saving.value ||
    next < 1 ||
    next > 1000 ||
    (delta > 0 && items.value.length < 100)
  )
    return
  page.value = next
  void load()
}
function abandon() {
  pending.value = null
  ambiguous.value = false
  void load()
}
onMounted(load)
const environmentLabel = (value: string) =>
  value === 'sandbox' ? 'Entorno de pruebas' : value === 'live' ? 'Producción' : adminHumanize(value)
const scopesLabel = (value: string) =>
  String(value)
    .replace(/requests\.read/g, 'Lectura')
    .replace(/requests\.write/g, 'Escritura')
    .replace(/[[\]"]/g, '')
    .replace(/\s*,\s*/g, ' y ')
const keyStatusLabel = (value: string) =>
  value === 'revoked' ? 'Anulada' : value === 'active' ? 'Activa' : adminStatusLabel(value)
const keyStatusTone = (value: string) => (value === 'active' ? 'success' : 'neutral')
</script>
<template>
  <AdminCard
    aria-labelledby="b2b-keys-title"
    description="Cada clave da acceso a los datos de su propia empresa. Si se pierde, anúlala y crea otra."
    flush
  >
    <template #title><span id="b2b-keys-title">Claves de acceso para empresas</span></template>
    <p v-if="loading" role="status" class="adm-help p-4">Cargando claves…</p>
    <div v-else-if="loadError" role="alert">
      <AdminEmptyState
        variant="error"
        compact
        title="No se pudieron cargar las claves"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <button type="button" class="adm-btn adm-btn--secondary" @click="load">Reintentar</button>
      </AdminEmptyState>
    </div>
    <AdminEmptyState
      v-else-if="!items.length"
      compact
      icon="i-lucide-key-round"
      title="No hay claves"
      description="Crea la primera con el formulario de abajo."
    />
    <div v-else class="adm-table-wrap">
      <table class="adm-table">
        <thead>
          <tr>
            <th scope="col">Clave</th>
            <th scope="col">Entorno</th>
            <th scope="col">Empresa</th>
            <th scope="col">Permisos</th>
            <th scope="col" data-numeric>Límite diario</th>
            <th scope="col">Estado</th>
            <th scope="col" data-numeric><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>
              <code class="text-xs">{{ item.id }}</code>
            </td>
            <td>{{ environmentLabel(item.environment) }}</td>
            <td>{{ item.companyId ? `empresa ${item.companyId}` : '—' }}</td>
            <td>{{ scopesLabel(item.scopes) }}</td>
            <td data-numeric>{{ item.quotaDaily }}</td>
            <td>
              <AdminBadge :tone="keyStatusTone(item.status)">{{ keyStatusLabel(item.status) }}</AdminBadge>
            </td>
            <td data-numeric class="adm-table__actions">
              <button
                v-if="item.status === 'active'"
                type="button"
                class="adm-btn adm-btn--danger-soft adm-btn--sm"
                data-revoke
                :disabled="!!pending || saving"
                @click="revoke(item)"
              >
                Anular
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <nav aria-label="Páginas de claves" class="adm-pagination">
      <p>Página {{ page }}</p>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          data-previous-page
          :disabled="page === 1 || loading || !!pending || saving"
          @click="changePage(-1)"
        >
          Anterior
        </button>
        <button
          type="button"
          class="adm-btn adm-btn--secondary adm-btn--sm"
          data-next-page
          :disabled="items.length < 100 || page === 1000 || loading || !!pending || saving"
          @click="changePage(1)"
        >
          Siguiente
        </button>
      </div>
    </nav>
    <template #footer>
      <div class="adm-stack w-full">
        <UAlert
          v-if="message"
          role="status"
          :color="secret ? 'warning' : 'success'"
          variant="subtle"
          :icon="secret ? 'i-lucide-key-round' : 'i-lucide-circle-check'"
          :title="message"
        >
          <template v-if="secret" #description>
            <code class="break-all">{{ secret }}</code>
          </template>
        </UAlert>
        <UAlert
          v-if="ambiguous"
          role="alert"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="No sabemos si el cambio se guardó"
          description="El resultado desconocido requiere revisión. Reintenta la misma operación o revisa la lista antes de cerrarla."
        >
          <template #actions>
            <button
              type="button"
              class="adm-btn adm-btn--secondary adm-btn--sm"
              data-retry
              :disabled="saving"
              @click="send"
            >
              Reintentar operación
            </button>
            <button type="button" class="adm-btn adm-btn--ghost adm-btn--sm" :disabled="saving" @click="abandon">
              Cerrar operación y revisar claves
            </button>
          </template>
        </UAlert>
        <form @submit.prevent="create">
          <fieldset :disabled="!!pending || saving" class="adm-stack">
            <legend class="adm-label">Crear clave</legend>
            <div class="adm-form-grid">
              <div class="adm-field">
                <label for="b2b-env" class="adm-label">Entorno</label>
                <select id="b2b-env" v-model="environment" class="adm-input">
                  <option value="sandbox">Entorno de pruebas</option>
                  <option value="live">Producción</option>
                </select>
              </div>
              <div v-if="environment === 'live'" class="adm-field">
                <label for="b2b-company" class="adm-label">Identificador de empresa aprobada</label>
                <input id="b2b-company" v-model="companyId" class="adm-input" type="text" required maxlength="36" />
              </div>
              <div class="adm-field">
                <label for="b2b-quota" class="adm-label">Límite de solicitudes al día</label>
                <input
                  id="b2b-quota"
                  v-model.number="quota"
                  class="adm-input"
                  type="number"
                  min="1"
                  max="10000"
                  required
                />
              </div>
              <div class="adm-field">
                <span class="adm-label">Permisos</span>
                <label class="adm-check"><input v-model="read" type="checkbox" /> Lectura</label>
                <label class="adm-check"><input v-model="write" type="checkbox" /> Escritura</label>
              </div>
            </div>
            <div>
              <button type="submit" class="adm-btn adm-btn--secondary" :disabled="!read && !write">Crear clave</button>
            </div>
          </fieldset>
        </form>
      </div>
    </template>
  </AdminCard>
</template>
