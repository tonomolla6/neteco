<script setup lang="ts">
import { adminActivityResponseSchema, type AdminActivityItem, type AdminActivityKind } from '~~/shared/admin-activity'

const props = defineProps<{ scopeKey: string; enabled: boolean; pending: boolean }>()
const request = useRequestFetch(),
  prefix = useId()
const allowed = computed(() => props.enabled && !props.pending && !!props.scopeKey)
const items = shallowRef<AdminActivityItem[]>([])
const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
let alive = true,
  generation = 0,
  controller: AbortController | null = null
const kinds: Record<AdminActivityKind, string> = {
  catalog_category: 'Familias',
  catalog_product_status: 'Productos',
  catalog_policy: 'Políticas de publicación',
  cms_draft: 'Contenido',
  cms_publication: 'Publicación de contenido',
  inventory: 'Inventario',
  fulfillment: 'Pedidos',
  support: 'Soporte'
}
const actions: Record<AdminActivityItem['action'], string> = {
  create_category: 'Familia creada',
  update_category: 'Familia actualizada',
  delete_category: 'Familia retirada',
  draft: 'Estado: borrador',
  review: 'Estado: en revisión',
  published: 'Estado: publicado',
  hidden: 'Estado: oculto',
  discontinued: 'Estado: descatalogado',
  policy_create: 'Política creada',
  policy_withdraw: 'Política retirada',
  policy_assign: 'Política asignada',
  exception_create: 'Excepción creada',
  exception_withdraw: 'Excepción retirada',
  create_draft: 'Borrador creado',
  update_draft: 'Borrador actualizado',
  restore_draft: 'Borrador restaurado',
  archive_draft: 'Borrador archivado',
  publish: 'Publicación registrada',
  withdraw: 'Retirada registrada',
  schedule: 'Programación registrada',
  cancel_schedule: 'Programación cancelada',
  preview: 'Vista previa registrada',
  revoke_preview: 'Vista previa revocada',
  receipt: 'Entrada de inventario registrada',
  count_propose: 'Recuento propuesto',
  count_approve: 'Recuento aprobado',
  picking: 'Estado: en preparación',
  packed: 'Estado: empaquetado',
  ready_for_pickup: 'Estado: listo para recoger',
  in_transit: 'Estado: en tránsito',
  delivered: 'Estado: entregado',
  exception: 'Incidencia registrada',
  created: 'Caso creado',
  update: 'Caso actualizado',
  reply: 'Respuesta registrada',
  note: 'Nota registrada',
  call: 'Llamada registrada',
  attachment: 'Adjunto registrado'
}
function current(epoch: number, scope: string) {
  return alive && allowed.value && epoch === generation && scope === props.scopeKey
}
async function read() {
  if (!alive || !allowed.value || status.value === 'loading') return
  const epoch = generation,
    scope = props.scopeKey,
    abort = new AbortController()
  controller = abort
  items.value = []
  status.value = 'loading'
  try {
    const raw = await request('/api/admin/activity', {
      method: 'GET',
      query: { limit: 5 },
      cache: 'no-store',
      retry: 0,
      signal: abort.signal
    })
    if (!current(epoch, scope)) return
    const result = adminActivityResponseSchema.parse(raw)
    if (result.items.length > 5 || new Set(result.items.map((item) => item.id)).size !== result.items.length)
      throw new Error('unconfirmed_activity')
    items.value = result.items
    status.value = 'ready'
  } catch {
    if (current(epoch, scope)) {
      items.value = []
      status.value = 'error'
    }
  } finally {
    if (current(epoch, scope)) controller = null
  }
}
watch(
  [() => props.scopeKey, () => props.enabled, () => props.pending],
  () => {
    generation++
    controller?.abort()
    controller = null
    items.value = []
    status.value = 'idle'
    if (allowed.value) void read()
  },
  { immediate: true, flush: 'pre' }
)
onBeforeUnmount(() => {
  alive = false
  generation++
  controller?.abort()
  items.value = []
})
</script>
<template>
  <section v-if="allowed" :aria-labelledby="prefix + '-title'" class="min-w-0 max-w-full space-y-3">
    <h2 :id="prefix + '-title'" class="text-base font-semibold">Actividad auditada reciente</h2>
    <p class="text-sm text-muted">
      Últimos cinco registros disponibles según tus permisos. Fechas del servidor en UTC.
    </p>
    <p v-if="status === 'loading'" data-activity-loading role="status" aria-busy="true" class="text-sm">
      Consultando actividad auditada…
    </p>
    <div v-else-if="status === 'error'" data-activity-error role="alert" class="space-y-2 text-sm">
      <p>No se ha podido consultar la actividad auditada. Puedes volver a intentarlo.</p>
      <button data-activity-retry type="button" class="rounded border px-3 py-2 focus-visible:outline-2" @click="read">
        Reintentar lectura de actividad
      </button>
    </div>
    <p v-else-if="status === 'ready' && !items.length" data-activity-empty role="status" class="text-sm">
      No hay actividad auditada disponible según tus permisos.
    </p>
    <ol v-else-if="status === 'ready'" data-activity-list class="min-w-0 divide-y divide-[var(--border)]">
      <li
        v-for="item in items"
        :key="item.id"
        data-activity-item
        class="min-w-0 break-words py-3 [overflow-wrap:anywhere]"
      >
        <NuxtLink :to="item.to" class="underline focus-visible:outline-2"
          >{{ kinds[item.kind] }}: {{ actions[item.action] }}</NuxtLink
        >
        <time :datetime="item.createdAt" class="mt-1 block text-xs text-muted"
          >{{ item.createdAt.slice(0, 10) }} {{ item.createdAt.slice(11, 19) }} UTC</time
        >
      </li>
    </ol>
  </section>
</template>
