<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Feature flags · Admin' })

/**
 * Feature flags.
 *
 * Antes cada flag era un formulario de seis columnas desplegado en la lista, con nueve
 * controles editables por fila —incluido un `<select multiple>` de entornos y un `range`
 * de despliegue—, de modo que la pantalla era un muro de campos y no se veía de un vistazo
 * qué había activo. Y encima había otro formulario de nueve campos permanentemente abierto
 * para crear.
 *
 * Ahora la lista es de lectura: qué flag hay, si está activa, dónde y a cuánta gente. Editar
 * es una acción explícita, que es lo correcto para algo que cambia el comportamiento de
 * producción.
 */
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

const ENVIRONMENTS: FeatureEnvironment[] = ['local', 'test', 'preview', 'demo', 'staging', 'production']
const { data, refresh, status: fetchStatus } = await useFetch<{ flags: ApiFlag[] }>('/api/admin/feature-flags')
const toast = useToast()
const saving = ref(false)

const flags = computed(() => data.value?.flags ?? [])
const activeCount = computed(() => flags.value.filter((flag) => flag.enabled).length)
const expiredCount = computed(
  () => flags.value.filter((flag) => flag.expiresAt && new Date(flag.expiresAt) < new Date()).length
)

function isExpired(flag: ApiFlag) {
  return Boolean(flag.expiresAt) && new Date(flag.expiresAt) < new Date()
}

function blankDraft(): FlagDraft {
  return {
    key: '',
    description: '',
    owner: '',
    enabled: false,
    environments: [],
    percentage: 100,
    rolesText: '',
    customerIdsText: '',
    expiresAt: ''
  }
}

const draft = reactive<FlagDraft>(blankDraft())
const editingKey = ref<string | null>(null)
const dialogOpen = ref(false)

function startCreate() {
  Object.assign(draft, blankDraft())
  editingKey.value = null
  dialogOpen.value = true
}

function startEdit(flag: ApiFlag) {
  Object.assign(draft, {
    key: flag.key,
    description: flag.description,
    owner: flag.owner,
    enabled: flag.enabled,
    environments: [...flag.targeting.environments],
    percentage: flag.targeting.percentage,
    rolesText: flag.targeting.roles.join(', '),
    customerIdsText: flag.targeting.customerIds.join(', '),
    expiresAt: flag.expiresAt ? flag.expiresAt.slice(0, 16) : ''
  })
  editingKey.value = flag.key
  dialogOpen.value = true
}

function values(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function payload() {
  return {
    description: draft.description,
    owner: draft.owner,
    enabled: draft.enabled,
    targeting: {
      environments: draft.environments,
      percentage: draft.percentage,
      roles: values(draft.rolesText),
      customerIds: values(draft.customerIdsText)
    },
    expiresAt: new Date(draft.expiresAt).toISOString()
  }
}

async function save() {
  saving.value = true
  try {
    if (editingKey.value) {
      await $fetch(`/api/admin/feature-flags/${editingKey.value}`, {
        method: 'PUT',
        body: { ...payload(), reason: 'Cambio de configuración auditado desde el panel' }
      })
      toast.add({ title: `${editingKey.value} actualizada`, color: 'success', icon: 'i-lucide-check' })
    } else {
      await $fetch('/api/admin/feature-flags', { method: 'POST', body: { key: draft.key, ...payload() } })
      toast.add({ title: 'Flag creada, desactivada', color: 'success', icon: 'i-lucide-check' })
    }
    dialogOpen.value = false
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido guardar la flag'), color: 'error' })
  } finally {
    saving.value = false
  }
}

/** Encender o apagar sin abrir el diálogo: es lo que más se hace. */
async function quickToggle(flag: ApiFlag) {
  saving.value = true
  try {
    await $fetch(`/api/admin/feature-flags/${flag.key}`, {
      method: 'PUT',
      body: {
        description: flag.description,
        owner: flag.owner,
        enabled: !flag.enabled,
        targeting: flag.targeting,
        expiresAt: flag.expiresAt,
        reason: `${flag.enabled ? 'Desactivada' : 'Activada'} desde el panel`
      }
    })
    await refresh()
    toast.add({ title: `${flag.key} ${flag.enabled ? 'desactivada' : 'activada'}`, color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cambiar la flag'), color: 'error' })
  } finally {
    saving.value = false
  }
}

const removing = ref<ApiFlag | null>(null)

async function confirmRemove() {
  const flag = removing.value
  if (!flag) return
  saving.value = true
  try {
    await $fetch(`/api/admin/feature-flags/${flag.key}`, {
      method: 'DELETE',
      query: { reason: 'Limpieza de flag retirada desde el panel' }
    })
    removing.value = null
    await refresh()
    toast.add({ title: `${flag.key} eliminada`, color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido eliminar la flag'), color: 'error' })
  } finally {
    saving.value = false
  }
}

function audience(flag: ApiFlag) {
  const parts: string[] = []
  if (flag.targeting.percentage < 100) parts.push(`${flag.targeting.percentage} % del tráfico`)
  if (flag.targeting.roles.length) parts.push(`roles: ${flag.targeting.roles.join(', ')}`)
  if (flag.targeting.customerIds.length) parts.push(`${flag.targeting.customerIds.length} clientes concretos`)
  return parts.length ? parts.join(' · ') : 'Todo el mundo'
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <UiPageHeader
      title="Feature flags"
      :count="flags.length"
      :count-label="flags.length === 1 ? 'flag' : 'flags'"
      description="Cada flag tiene responsable y caducidad. Una flag activa no se puede eliminar: primero se apaga."
    >
      <template #actions>
        <UButton icon="i-lucide-plus" @click="startCreate">Nueva flag</UButton>
      </template>
    </UiPageHeader>

    <UAlert
      v-if="expiredCount"
      class="mb-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-calendar-x"
      :title="`${expiredCount} ${expiredCount === 1 ? 'flag ha caducado' : 'flags han caducado'}`"
      description="Una flag caducada es deuda técnica: o se convierte en comportamiento fijo o se retira."
    />

    <p v-if="flags.length" class="mb-3 text-sm text-[var(--text-muted)]">
      {{ activeCount }} {{ activeCount === 1 ? 'activa' : 'activas' }} de {{ flags.length }}.
    </p>

    <UiSurface padding="none">
      <div v-if="fetchStatus === 'pending'" class="divide-y divide-[var(--border)]">
        <div v-for="n in 3" :key="n" class="px-4 py-5">
          <div class="h-4 w-1/3 animate-pulse rounded bg-[var(--surface-sunken)]" />
        </div>
      </div>

      <UiEmptyState
        v-else-if="!flags.length"
        icon="i-lucide-toggle-right"
        title="No hay ninguna feature flag"
        description="Sirven para publicar código sin activarlo y encenderlo cuando toque, o para probar algo con una parte del tráfico. Se crean siempre desactivadas."
      >
        <UButton icon="i-lucide-plus" @click="startCreate">Crear la primera</UButton>
      </UiEmptyState>

      <ul v-else class="divide-y divide-[var(--border)]">
        <li v-for="flag in flags" :key="flag.key" class="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-sm font-semibold text-[var(--text-strong)]">{{ flag.key }}</code>
              <UBadge :color="flag.enabled ? 'success' : 'neutral'" variant="subtle">
                {{ flag.enabled ? 'Activa' : 'Desactivada' }}
              </UBadge>
              <UBadge v-if="isExpired(flag)" color="warning" variant="subtle">Caducada</UBadge>
            </div>
            <p class="mt-1 text-sm text-[var(--text)]">{{ flag.description || 'Sin descripción' }}</p>
            <p class="mt-0.5 text-xs text-[var(--text-muted)]">
              {{ flag.owner || 'Sin responsable' }} · {{ audience(flag) }}
              <template v-if="flag.targeting.environments.length">
                · {{ flag.targeting.environments.join(', ') }}
              </template>
              <template v-if="flag.expiresAt">
                · caduca el {{ new Date(flag.expiresAt).toLocaleDateString('es-ES') }}
              </template>
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <USwitch
              :model-value="flag.enabled"
              :disabled="saving"
              :aria-label="`${flag.enabled ? 'Desactivar' : 'Activar'} ${flag.key}`"
              @update:model-value="quickToggle(flag)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-pencil"
              :aria-label="`Editar ${flag.key}`"
              @click="startEdit(flag)"
            />
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              :disabled="flag.enabled"
              :title="flag.enabled ? 'Desactívala antes de eliminarla' : undefined"
              :aria-label="`Eliminar ${flag.key}`"
              @click="removing = flag"
            />
          </div>
        </li>
      </ul>
    </UiSurface>

    <UModal v-model:open="dialogOpen" :title="editingKey ? `Editar ${editingKey}` : 'Nueva feature flag'">
      <template #body>
        <form id="flag-form" class="space-y-4" @submit.prevent="save">
          <UFormField
            v-if="!editingKey"
            label="Clave"
            required
            hint="En minúsculas y por puntos: checkout.nuevo-resumen"
          >
            <UInput v-model="draft.key" class="w-full font-mono" placeholder="checkout.nuevo-resumen" />
          </UFormField>

          <UFormField label="Qué hace" required>
            <UInput v-model="draft.description" class="w-full" placeholder="Resumen de pedido nuevo en el checkout" />
          </UFormField>

          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Responsable" required hint="Quién decide si se queda o se retira">
              <UInput v-model="draft.owner" class="w-full" />
            </UFormField>
            <UFormField label="Caduca el" required>
              <UInput v-model="draft.expiresAt" type="datetime-local" class="w-full" />
            </UFormField>
          </div>

          <UFormField label="Entornos" hint="Dónde puede estar activa">
            <div class="flex flex-wrap gap-3 pt-1">
              <UCheckbox
                v-for="environment in ENVIRONMENTS"
                :key="environment"
                :model-value="draft.environments.includes(environment)"
                :label="environment"
                @update:model-value="
                  (checked) =>
                    (draft.environments = checked
                      ? [...draft.environments, environment]
                      : draft.environments.filter((item) => item !== environment))
                "
              />
            </div>
          </UFormField>

          <UFormField :label="`Despliegue: ${draft.percentage} % del tráfico`">
            <input v-model.number="draft.percentage" type="range" min="0" max="100" class="w-full" />
          </UFormField>

          <div class="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <UFormField label="Solo estos roles" hint="Separados por comas. Vacío = todos.">
              <UInput v-model="draft.rolesText" class="w-full" placeholder="admin, staff" />
            </UFormField>
            <UFormField label="Solo estos clientes" hint="UUID separados por comas">
              <UInput v-model="draft.customerIdsText" class="w-full font-mono text-xs" />
            </UFormField>
          </div>

          <UCheckbox
            v-if="editingKey"
            v-model="draft.enabled"
            label="Activa"
            :description="'Con la flag activa, el comportamiento nuevo se aplica según el targeting de arriba.'"
          />
          <p v-else class="text-sm text-[var(--text-muted)]">
            La flag se crea desactivada. La enciendes cuando el código esté listo.
          </p>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="dialogOpen = false">Cancelar</UButton>
          <UButton type="submit" form="flag-form" :loading="saving">
            {{ editingKey ? 'Guardar cambios' : 'Crear flag' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal :open="Boolean(removing)" title="Eliminar flag" @update:open="(value) => !value && (removing = null)">
      <template #body>
        <p class="text-[var(--text)]">
          Se eliminará <code class="font-mono">{{ removing?.key }}</code
          >. El código que la consulte pasará a usar su valor por defecto.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="removing = null">Cancelar</UButton>
          <UButton color="error" :loading="saving" @click="confirmRemove">Eliminar flag</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
