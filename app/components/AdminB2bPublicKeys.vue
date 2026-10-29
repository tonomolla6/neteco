<script setup lang="ts">
import { onMounted, ref } from 'vue'
const requestFetch = useRequestFetch()
type Key = { id: string; environment: string; scopes: string; quotaDaily: number; status: string; version: number; createdAt: string }
type Command = { action: 'create'; environment: 'sandbox' | 'live'; scopes: string[]; quotaDaily: number } | { action: 'revoke'; id: string; expectedVersion: number }
const items = ref<Key[]>([])
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
const pending = ref<{ id: string; body: Command } | null>(null)
async function load() {
  loading.value = true
  loadError.value = false
  try { items.value = (await requestFetch<{ items: Key[] }>('/api/admin/b2b-public/keys')).items }
  catch { loadError.value = true; items.value = [] }
  finally { loading.value = false }
}
async function send() {
  if (!pending.value || saving.value) return
  saving.value = true
  ambiguous.value = false
  secret.value = null
  message.value = ''
  try {
    const result = await requestFetch<{ id: string; key: string | null }>('/api/admin/b2b-public/keys', {
      method: 'POST', headers: { 'Idempotency-Key': pending.value.id }, body: pending.value.body
    })
    if (pending.value.body.action === 'create') {
      secret.value = result.key
      message.value = result.key ? 'Copia la clave ahora; solo se muestra una vez.' : 'El secreto ya no está disponible. Revoca la clave y crea otra.'
    } else message.value = 'Clave revocada.'
    pending.value = null
    await load()
  } catch { ambiguous.value = true }
  finally { saving.value = false }
}
function create() {
  if (pending.value || saving.value || (!read.value && !write.value)) return
  const scopes = [read.value ? 'requests.read' : '', write.value ? 'requests.write' : ''].filter(Boolean)
  pending.value = { id: crypto.randomUUID(), body: { action: 'create', environment: environment.value, scopes, quotaDaily: Number(quota.value) } }
  void send()
}
function revoke(key: Key) {
  if (pending.value || saving.value) return
  pending.value = { id: crypto.randomUUID(), body: { action: 'revoke', id: key.id, expectedVersion: key.version } }
  void send()
}
function abandon() { pending.value = null; ambiguous.value = false; void load() }
onMounted(load)
</script>
<template>
  <section aria-labelledby="b2b-keys-title" class="space-y-4">
    <h2 id="b2b-keys-title" class="text-xl font-semibold">Claves B2B</h2>
    <p>La clave da acceso al registro propio. Si pierdes el secreto, revócala y crea otra.</p>
    <p v-if="loading" role="status">Cargando claves…</p>
    <div v-else-if="loadError" role="alert">No se pudieron cargar las claves. <button type="button" @click="load">Reintentar</button></div>
    <p v-else-if="!items.length">No hay claves.</p>
    <ul v-else>
      <li v-for="item in items" :key="item.id">
        <code>{{ item.id }}</code> · {{ item.environment }} · {{ item.scopes }} · cuota {{ item.quotaDaily }} · {{ item.status }}
        <button v-if="item.status === 'active'" type="button" data-revoke :disabled="!!pending || saving" @click="revoke(item)">Revocar</button>
      </li>
    </ul>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="secret"><code>{{ secret }}</code></p>
    <div v-if="ambiguous" role="alert">
      <p>El resultado desconocido requiere revisión. Reintenta el mismo comando o revisa la lista antes de cerrarlo.</p>
      <button type="button" data-retry :disabled="saving" @click="send">Reintentar operación</button>
      <button type="button" :disabled="saving" @click="abandon">Cerrar operación y revisar claves</button>
    </div>
    <form @submit.prevent="create">
      <fieldset :disabled="!!pending || saving">
        <legend>Crear clave</legend>
        <label for="b2b-env">Entorno</label>
        <select id="b2b-env" v-model="environment"><option value="sandbox">Sandbox</option><option value="live">Live</option></select>
        <label><input v-model="read" type="checkbox" /> Lectura</label>
        <label><input v-model="write" type="checkbox" /> Escritura</label>
        <label for="b2b-quota">Cuota diaria</label>
        <input id="b2b-quota" v-model.number="quota" type="number" min="1" max="10000" required />
        <button type="submit" :disabled="!read && !write">Crear clave</button>
      </fieldset>
    </form>
  </section>
</template>
