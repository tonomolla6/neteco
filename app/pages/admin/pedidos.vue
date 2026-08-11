<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Pedidos · Admin' })

const { data, refresh } = await useFetch('/api/admin/orders')
const items = computed(() => (data.value as any)?.items ?? [])

const toast = useToast()
async function setStatus(o: any, ev: Event) {
  const status = (ev.target as HTMLSelectElement).value
  try {
    await $fetch(`/api/admin/orders/${o.id}`, { method: 'PUT', body: { status } })
    toast.add({ title: `Pedido ${o.id} → ${ORDER_STATUS[status]?.label ?? status}`, icon: 'i-lucide-check', color: 'success' })
    refresh()
  } catch (e: any) {
    toast.add({ title: e?.data?.statusMessage ?? 'No se ha podido cambiar el estado', color: 'error', icon: 'i-lucide-alert-circle' })
    refresh()
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Pedidos</h1>

    <div class="mt-4 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[820px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th class="px-4 py-3">Pedido</th>
            <th class="px-4 py-3">Fecha</th>
            <th class="px-4 py-3">Cliente</th>
            <th class="px-4 py-3 text-center">Líneas</th>
            <th class="px-4 py-3 text-right">Total</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3 text-right">Ver</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in items" :key="o.id" class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
            <td class="px-4 py-2.5 font-mono text-xs text-slate-700">{{ o.id }}</td>
            <td class="px-4 py-2.5 text-slate-600">{{ formatDate(o.createdAt) }}</td>
            <td class="px-4 py-2.5">
              <p class="font-medium text-slate-800">{{ o.name }}<template v-if="o.company"> · {{ o.company }}</template></p>
              <p class="text-xs text-slate-500">{{ o.email }} · {{ o.city }}</p>
            </td>
            <td class="px-4 py-2.5 text-center text-slate-600">{{ o.lines }}</td>
            <td class="px-4 py-2.5 text-right font-medium text-slate-800">{{ formatPrice(o.total) }}</td>
            <td class="px-4 py-2.5">
              <select
                :value="o.status"
                :aria-label="`Estado del pedido ${o.id}`"
                class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-neteco-500 focus:outline-none"
                @change="setStatus(o, $event)"
              >
                <option v-for="(s, key) in ORDER_STATUS" :key="key" :value="key">{{ s.label }}</option>
              </select>
            </td>
            <td class="px-4 py-2.5 text-right">
              <UButton
                :to="`/pedido/${o.id}?token=${o.token}`"
                target="_blank"
                size="xs"
                variant="soft"
                icon="i-lucide-external-link"
                aria-label="Ver pedido"
              />
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="7" class="px-4 py-10 text-center text-slate-500">Todavía no hay pedidos.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
