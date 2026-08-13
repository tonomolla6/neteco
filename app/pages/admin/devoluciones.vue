<script setup lang="ts">
import type { AdminReturnSummary } from '~~/shared/types/admin'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Devoluciones · Admin' })

const { data, refresh } = await useFetch<{ items: AdminReturnSummary[] }>('/api/admin/returns')
const items = computed(() => data.value?.items ?? [])
const toast = useToast()

async function transition(item: AdminReturnSummary) {
  const status = window.prompt(
    `Nuevo estado para ${item.id}: requested, approved, rejected, in_transit, received, inspected o resolved`,
    item.status
  )
  if (!status || status === item.status) return
  const reason = window.prompt('Motivo operativo obligatorio:')?.trim()
  if (!reason || reason.length < 3) return
  const resolution = status === 'resolved' ? window.prompt('Resolución aplicada:')?.trim() : undefined
  const refundEuros = status === 'resolved' ? window.prompt('Reembolso en euros (vacío si no corresponde):') : ''
  const refundAmountCents = refundEuros?.trim() ? Math.round(Number(refundEuros.replace(',', '.')) * 100) : undefined
  try {
    await $fetch(`/api/admin/returns/${item.id}`, {
      method: 'PUT',
      body: { status, reason, resolution, refundAmountCents }
    })
    toast.add({ title: `${item.id} actualizado`, color: 'success', icon: 'i-lucide-check' })
    await refresh()
  } catch (error) {
    toast.add({
      title: apiErrorMessage(error, 'No se ha podido cambiar la devolución'),
      color: 'error',
      icon: 'i-lucide-triangle-alert'
    })
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Devoluciones y reembolsos</h1>
    <p class="mt-1 text-sm text-slate-500">Autoriza, recibe, inspecciona y resuelve cada RMA con trazabilidad.</p>

    <div class="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[980px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th class="px-4 py-3">RMA / pedido</th>
            <th class="px-4 py-3">Cliente</th>
            <th class="px-4 py-3">Motivo</th>
            <th class="px-4 py-3">Unidades</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3">Reembolso</th>
            <th class="px-4 py-3 text-right">Acción</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id" class="border-b border-slate-100 align-top last:border-0">
            <td class="px-4 py-3">
              <p class="font-mono text-xs font-semibold">{{ item.id }}</p>
              <NuxtLink :to="`/pedido/${item.orderNumber}`" target="_blank" class="text-xs text-neteco-700 underline">
                {{ item.orderNumber }}
              </NuxtLink>
            </td>
            <td class="px-4 py-3">
              <p class="font-medium text-slate-800">{{ item.customerName }}</p>
              <p class="text-xs text-slate-500">{{ item.email }}</p>
            </td>
            <td class="max-w-xs px-4 py-3 text-slate-600">{{ item.reason }}</td>
            <td class="px-4 py-3">{{ item.quantity }}</td>
            <td class="px-4 py-3">
              <UBadge variant="subtle">{{ item.status }}</UBadge>
            </td>
            <td class="px-4 py-3">
              <template v-if="item.refundAmountCents">
                {{ formatPrice(item.refundAmountCents) }} · {{ item.refundStatus }}
              </template>
              <span v-else class="text-slate-400">—</span>
            </td>
            <td class="px-4 py-3 text-right">
              <UButton size="xs" variant="soft" icon="i-lucide-arrow-right-left" @click="transition(item)">
                Cambiar estado
              </UButton>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="7" class="px-4 py-10 text-center text-slate-500">No hay devoluciones registradas.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
