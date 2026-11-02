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
</script>
<template>
  <section aria-labelledby="b2b-keys-title" class="space-y-4">
    <h2 id="b2b-keys-title" class="text-xl font-semibold">Claves B2B</h2>
    <p>La clave da acceso al registro propio. Si pierdes el secreto, revócala y crea otra.</p>
    <p v-if="loading" role="status">Cargando claves…</p>
    <div v-else-if="loadError" role="alert">
      No se pudieron cargar las claves. <button type="button" @click="load">Reintentar</button>
    </div>
    <p v-else-if="!items.length">No hay claves.</p>
    <ul v-else>
      <li v-for="item in items" :key="item.id">
        <code>{{ item.id }}</code> · {{ item.environment }}
        <template v-if="item.companyId">· Empresa {{ item.companyId }}</template> · {{ item.scopes }} · cuota
        {{ item.quotaDaily }} · {{ item.status }}
        <button
          v-if="item.status === 'active'"
          type="button"
          data-revoke
          :disabled="!!pending || saving"
          @click="revoke(item)"
        >
          Revocar
        </button>
      </li>
    </ul>
    <nav aria-label="Páginas de claves">
      <button
        type="button"
        data-previous-page
        :disabled="page === 1 || loading || !!pending || saving"
        @click="changePage(-1)"
      >
        Anterior
      </button>
      <span>Página {{ page }}</span>
      <button
        type="button"
        data-next-page
        :disabled="items.length < 100 || page === 1000 || loading || !!pending || saving"
        @click="changePage(1)"
      >
        Siguiente
      </button>
    </nav>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="secret">
      <code>{{ secret }}</code>
    </p>
    <div v-if="ambiguous" role="alert">
      <p>El resultado desconocido requiere revisión. Reintenta el mismo comando o revisa la lista antes de cerrarlo.</p>
      <button type="button" data-retry :disabled="saving" @click="send">Reintentar operación</button>
      <button type="button" :disabled="saving" @click="abandon">Cerrar operación y revisar claves</button>
    </div>
    <form @submit.prevent="create">
      <fieldset :disabled="!!pending || saving">
        <legend>Crear clave</legend>
        <label for="b2b-env">Entorno</label>
        <select id="b2b-env" v-model="environment">
          <option value="sandbox">Sandbox</option>
          <option value="live">Live</option>
        </select>
        <template v-if="environment === 'live'"
          ><label for="b2b-company">Identificador de empresa aprobada</label
          ><input id="b2b-company" v-model="companyId" type="text" required maxlength="36"
        /></template>
        <label><input v-model="read" type="checkbox" /> Lectura</label>
        <label><input v-model="write" type="checkbox" /> Escritura</label>
        <label for="b2b-quota">Cuota diaria</label>
        <input id="b2b-quota" v-model.number="quota" type="number" min="1" max="10000" required />
        <button type="submit" :disabled="!read && !write">Crear clave</button>
      </fieldset>
    </form>
  </section>
</template>
