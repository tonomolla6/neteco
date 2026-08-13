<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Operaciones · Admin' })

interface Operations {
  summary: Record<string, number>
  queues: Array<{ eventType: string; status: string; depth: number; oldestAt: string; maxAttempts: number }>
  deadLetters: Array<{
    id: string
    eventType: string
    attempts: number
    errorCode: string | null
    errorMessage: string
    createdAt: string
  }>
  generatedAt: string
}

const { data, refresh } = await useFetch<Operations>('/api/admin/operations')
const toast = useToast()

const cards = computed(() => [
  ['Cola activa', data.value?.summary.queueDepth ?? '—', 'i-lucide-list-restart'],
  ['DLQ', data.value?.summary.deadLetters ?? '—', 'i-lucide-triangle-alert'],
  ['SLA soporte vencido', data.value?.summary.supportOverdue ?? '—', 'i-lucide-clock-alert'],
  ['Excepciones fiscales', data.value?.summary.fiscalExceptions ?? '—', 'i-lucide-file-warning'],
  ['Reembolsos estancados', data.value?.summary.staleRefunds ?? '—', 'i-lucide-banknote-x'],
  ['Inventario anómalo', data.value?.summary.inventoryExceptions ?? '—', 'i-lucide-package-x'],
  ['Envíos sin avance', data.value?.summary.staleShipments ?? '—', 'i-lucide-truck'],
  ['Correo rebotado/queja', data.value?.summary.communicationFailures ?? '—', 'i-lucide-mail-warning']
])

async function retry(id: string) {
  const reason = window.prompt('Motivo del replay (obligatorio):')?.trim()
  if (!reason) return
  try {
    await $fetch(`/api/admin/operations/outbox/${id}/retry`, { method: 'POST', body: { reason } })
    toast.add({ title: 'Evento devuelto a la cola', color: 'success', icon: 'i-lucide-refresh-cw' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido reintentar'), color: 'error' })
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold text-slate-900">Operaciones y colas</h1>
        <p class="mt-1 text-sm text-slate-500">
          Backlog, excepciones y replay auditado. Los payloads sensibles no se muestran.
        </p>
      </div>
      <UButton variant="soft" icon="i-lucide-refresh-cw" @click="() => refresh()">Actualizar</UButton>
    </div>

    <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      <div v-for="card in cards" :key="String(card[0])" class="rounded-2xl border border-slate-200 bg-white p-4">
        <UIcon :name="String(card[2])" class="size-5 text-neteco-600" />
        <p class="mt-2 text-2xl font-bold text-slate-900">{{ card[1] }}</p>
        <p class="text-xs text-slate-500">{{ card[0] }}</p>
      </div>
    </div>

    <section class="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <h2 class="px-4 pt-4 font-bold text-slate-900">Estado de workers</h2>
      <table class="mt-2 w-full min-w-[700px] text-sm">
        <thead>
          <tr class="border-y border-slate-200 text-left text-xs uppercase text-slate-500">
            <th class="px-4 py-3">Evento</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3">Profundidad</th>
            <th class="px-4 py-3">Más antiguo</th>
            <th class="px-4 py-3">Intentos máx.</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="queue in data?.queues"
            :key="`${queue.eventType}:${queue.status}`"
            class="border-b border-slate-100"
          >
            <td class="px-4 py-3 font-mono text-xs">{{ queue.eventType }}</td>
            <td class="px-4 py-3">{{ queue.status }}</td>
            <td class="px-4 py-3">{{ queue.depth }}</td>
            <td class="px-4 py-3">{{ new Date(queue.oldestAt).toLocaleString('es-ES') }}</td>
            <td class="px-4 py-3">{{ queue.maxAttempts }}</td>
          </tr>
          <tr v-if="!data?.queues.length">
            <td colspan="5" class="px-4 py-8 text-center text-slate-500">No hay backlog.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="mt-6 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <h2 class="px-4 pt-4 font-bold text-slate-900">Dead-letter queue</h2>
      <table class="mt-2 w-full min-w-[850px] text-sm">
        <thead>
          <tr class="border-y border-slate-200 text-left text-xs uppercase text-slate-500">
            <th class="px-4 py-3">Evento</th>
            <th class="px-4 py-3">Error saneado</th>
            <th class="px-4 py-3">Intentos</th>
            <th class="px-4 py-3 text-right">Acción</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in data?.deadLetters" :key="item.id" class="border-b border-slate-100 align-top">
            <td class="px-4 py-3">
              <p class="font-mono text-xs">{{ item.eventType }}</p>
              <p class="mt-1 text-xs text-slate-400">{{ item.id }}</p>
            </td>
            <td class="max-w-xl px-4 py-3">
              <p class="font-medium">{{ item.errorCode || 'sin código' }}</p>
              <p class="text-xs text-slate-500">{{ item.errorMessage }}</p>
            </td>
            <td class="px-4 py-3">{{ item.attempts }}</td>
            <td class="px-4 py-3 text-right">
              <UButton size="xs" variant="soft" @click="retry(item.id)">Reintentar</UButton>
            </td>
          </tr>
          <tr v-if="!data?.deadLetters.length">
            <td colspan="4" class="px-4 py-8 text-center text-slate-500">No hay eventos muertos.</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
