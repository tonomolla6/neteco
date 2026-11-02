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
  <section aria-labelledby="ownership-title" class="space-y-4">
    <h2 id="ownership-title" class="text-xl font-semibold">Responsables de servicios</h2>
    <p>Registra códigos de equipo; evita nombres de personas o datos de contacto.</p>
    <p v-if="loading" role="status">Cargando responsables…</p>
    <div v-else-if="failed" role="alert">
      No se pudieron cargar los responsables. <button type="button" @click="load">Reintentar</button>
    </div>
    <ul v-else>
      <li v-for="service in developerServices" :key="service.id">
        {{ service.name }}:
        {{ rows.find((item) => item.serviceId === service.id)?.owner ?? 'Sin responsable asignado' }}
      </li>
    </ul>
    <div v-if="ambiguous" role="alert">
      <p>
        El resultado desconocido requiere revisión. Puedes reintentar el mismo comando o recargar antes de otro cambio.
      </p>
      <button type="button" data-retry-owner :disabled="saving" @click="send">Reintentar operación</button>
      <button type="button" :disabled="saving" @click="abandon">Cerrar operación y recargar</button>
    </div>
    <form @submit.prevent="submit">
      <fieldset :disabled="loading || failed || !!pending || saving">
        <legend>Asignar responsable</legend>
        <label for="developer-service">Servicio</label>
        <select id="developer-service" v-model="serviceId">
          <option v-for="service in developerServices" :key="service.id" :value="service.id">{{ service.name }}</option>
        </select>
        <label for="developer-owner">Código de equipo</label>
        <input
          id="developer-owner"
          v-model="owner"
          type="text"
          pattern="[a-z][a-z0-9._-]{1,63}"
          maxlength="64"
          required
        />
        <button type="submit">Guardar responsable</button>
      </fieldset>
    </form>
  </section>
</template>
