<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Feature flags · Admin' })

type FeatureEnvironment = 'local' | 'test' | 'preview' | 'demo' | 'staging' | 'production'

interface ApiFlag {
  key: string
  description: string
  owner: string
  enabled: boolean
  targeting: { environments: FeatureEnvironment[]; percentage: number; roles: string[]; customerIds: string[] }
  expiresAt: string
}

interface FlagDraft {
  key: string
  description: string
  owner: string
  enabled: boolean
  environments: FeatureEnvironment[]
  percentage: number
  rolesText: string
  customerIdsText: string
  expiresAt: string
}

const environmentOptions: FeatureEnvironment[] = ['local', 'test', 'preview', 'demo', 'staging', 'production']
const { data, refresh } = await useFetch<{ flags: ApiFlag[] }>('/api/admin/feature-flags')
const flags = ref<FlagDraft[]>([])
watch(
  data,
  (payload) => {
    flags.value = (payload?.flags ?? []).map((flag) => ({
      key: flag.key,
      description: flag.description,
      owner: flag.owner,
      enabled: flag.enabled,
      environments: flag.targeting.environments,
      percentage: flag.targeting.percentage,
      rolesText: flag.targeting.roles.join(', '),
      customerIdsText: flag.targeting.customerIds.join(', '),
      expiresAt: flag.expiresAt.slice(0, 16)
    }))
  },
  { immediate: true }
)
const toast = useToast()
const form = reactive<FlagDraft>({
  key: '',
  description: '',
  owner: '',
  enabled: false,
  environments: [],
  percentage: 100,
  rolesText: '',
  customerIdsText: '',
  expiresAt: ''
})

function values(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function body(flag: FlagDraft) {
  return {
    description: flag.description,
    owner: flag.owner,
    enabled: flag.enabled,
    targeting: {
      environments: flag.environments,
      percentage: flag.percentage,
      roles: values(flag.rolesText),
      customerIds: values(flag.customerIdsText)
    },
    expiresAt: new Date(flag.expiresAt).toISOString()
  }
}

async function createFlag() {
  try {
    await $fetch('/api/admin/feature-flags', { method: 'POST', body: { key: form.key, ...body(form) } })
    Object.assign(form, {
      key: '',
      description: '',
      owner: '',
      enabled: false,
      environments: [],
      percentage: 100,
      rolesText: '',
      customerIdsText: '',
      expiresAt: ''
    })
    await refresh()
    toast.add({ title: 'Flag creada', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido crear la flag'), color: 'error' })
  }
}

async function save(flag: FlagDraft) {
  try {
    await $fetch(`/api/admin/feature-flags/${flag.key}`, {
      method: 'PUT',
      body: { ...body(flag), reason: 'Cambio de configuración auditado desde el panel' }
    })
    await refresh()
    toast.add({ title: `${flag.key} actualizada`, color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido actualizar la flag'), color: 'error' })
  }
}

async function remove(flag: FlagDraft) {
  if (!confirm(`¿Eliminar la flag inactiva ${flag.key}?`)) return
  try {
    await $fetch(`/api/admin/feature-flags/${flag.key}`, {
      method: 'DELETE',
      query: { reason: 'Limpieza de flag retirada desde el panel' }
    })
    await refresh()
    toast.add({ title: `${flag.key} eliminada`, color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido eliminar la flag'), color: 'error' })
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Feature flags</h1>
    <p class="mt-1 text-sm text-slate-500">
      Owner, caducidad, targeting y cambios auditados; una flag activa no se elimina.
    </p>

    <form
      class="mt-6 grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 md:grid-cols-3"
      @submit.prevent="createFlag"
    >
      <UInput v-model="form.key" placeholder="checkout.nuevo-resumen" />
      <UInput v-model="form.description" placeholder="Descripción" />
      <UInput v-model="form.owner" placeholder="Owner" />
      <UInput v-model="form.expiresAt" type="datetime-local" />
      <UInput v-model.number="form.percentage" type="number" min="0" max="100" placeholder="Porcentaje" />
      <UInput v-model="form.rolesText" placeholder="Roles, separados por comas" />
      <UInput v-model="form.customerIdsText" placeholder="UUID de clientes, separados por comas" />
      <label class="text-xs text-slate-600 md:col-span-2">
        Entornos
        <select v-model="form.environments" multiple class="mt-1 w-full rounded-lg border border-slate-300 p-2">
          <option v-for="environment in environmentOptions" :key="environment" :value="environment">
            {{ environment }}
          </option>
        </select>
      </label>
      <UButton type="submit" icon="i-lucide-plus">Crear desactivada</UButton>
    </form>

    <div class="mt-5 space-y-3">
      <form
        v-for="flag in flags"
        :key="flag.key"
        class="grid gap-3 rounded-2xl border border-slate-200 bg-white p-5 md:grid-cols-6"
        @submit.prevent="save(flag)"
      >
        <div>
          <strong class="font-mono text-sm">{{ flag.key }}</strong>
        </div>
        <UInput v-model="flag.description" aria-label="Descripción" />
        <UInput v-model="flag.owner" aria-label="Owner" />
        <UInput v-model="flag.expiresAt" type="datetime-local" aria-label="Caducidad" />
        <label class="flex items-center gap-2 text-sm"><input v-model="flag.enabled" type="checkbox" /> Activa</label>
        <div class="flex gap-2">
          <UButton type="submit" size="sm" icon="i-lucide-save">Guardar</UButton>
          <UButton type="button" size="sm" color="error" variant="ghost" :disabled="flag.enabled" @click="remove(flag)">
            Eliminar
          </UButton>
        </div>
        <label class="text-xs text-slate-500 md:col-span-6">
          Despliegue {{ flag.percentage }} %
          <input v-model.number="flag.percentage" type="range" min="0" max="100" class="ml-2 align-middle" />
        </label>
        <label class="text-xs text-slate-600 md:col-span-2">
          Entornos
          <select v-model="flag.environments" multiple class="mt-1 w-full rounded-lg border border-slate-300 p-2">
            <option v-for="environment in environmentOptions" :key="environment" :value="environment">
              {{ environment }}
            </option>
          </select>
        </label>
        <UInput
          v-model="flag.rolesText"
          class="md:col-span-2"
          aria-label="Roles"
          placeholder="Roles, separados por comas"
        />
        <UInput
          v-model="flag.customerIdsText"
          class="md:col-span-2"
          aria-label="Clientes"
          placeholder="UUID de clientes, separados por comas"
        />
      </form>
    </div>
  </div>
</template>
