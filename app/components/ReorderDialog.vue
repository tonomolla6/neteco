<script setup lang="ts">
const reorder = useReorder()
const emit = defineEmits<{ added: [number]; activity: [boolean] }>()
const activitySession = useUserSession()

const open = computed({
  get: () =>
    Boolean(reorder.plan.value) || reorder.loading.value || reorder.canRetry.value || Boolean(reorder.error.value),
  set: (value: boolean) => {
    if (!value) reorder.close()
  }
})
watch(
  () => activitySession.loggedIn.value && (open.value || reorder.adding.value),
  (value) => emit('activity', value),
  { immediate: true, flush: 'sync' }
)
onBeforeUnmount(() => emit('activity', false))
watch(
  () =>
    JSON.stringify([
      activitySession.loggedIn.value,
      activitySession.user.value?.id,
      activitySession.session.value?.sessionId,
      activitySession.session.value?.sessionVersion,
      activitySession.user.value?.emailVerified
    ]),
  () => emit('activity', false),
  { flush: 'sync' }
)

async function confirm() {
  const result = await reorder.confirm()
  if (result.added) emit('added', result.added)
}

defineExpose({ start: reorder.open })
</script>

<template>
  <UModal v-model:open="open" title="Volver a pedir">
    <template #body>
      <div v-if="reorder.loading.value" role="status" aria-busy="true" class="space-y-3 py-2">
        <p class="sr-only">Preparando la repetición del pedido.</p>
        <div
          v-for="row in 3"
          :key="row"
          class="h-12 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <div v-else-if="reorder.plan.value" class="space-y-5">
        <p v-if="reorder.addedCount.value" role="status" class="text-sm">
          {{ reorder.addedCount.value }} líneas ya añadidas al carrito. No se volverán a añadir al reintentar.
        </p>
        <p class="text-sm text-[var(--text-muted)]">
          Del pedido
          <span class="tabular font-semibold text-[var(--text-strong)]">{{ reorder.plan.value.orderId }}</span> de
          {{ formatAccountDate(reorder.plan.value.orderedAt) }}. Revisa las cantidades antes de añadirlas al carrito:
          son cantidades y precios históricos. Al añadir, el carrito comprobará el precio, el stock y las condiciones
          vigentes.
        </p>

        <ul
          v-if="reorder.availableLines.value.length"
          class="divide-y divide-[var(--border)] rounded-[var(--radius-surface)] border border-[var(--border)]"
        >
          <li v-for="line in reorder.availableLines.value" :key="line.sku" class="flex items-center gap-3 p-3">
            <OrderLineThumb :line="line" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-[var(--text-strong)]">{{ line.name }}</p>
              <p class="truncate text-xs text-[var(--text-muted)]">{{ line.format }} · Ref. {{ line.sku }}</p>
              <p class="mt-2 text-xs text-[var(--text-muted)]">
                Precio histórico: {{ formatPrice(line.unitGross) }} por unidad · {{ formatPrice(line.lineGross) }} por
                línea (IVA incluido).
              </p>
              <div v-if="line.reorderOffer" class="mt-2 space-y-1 text-xs text-[var(--text-muted)]">
                <p
                  v-if="
                    line.unitGross !== line.reorderOffer.unitGross || line.lineGross !== line.reorderOffer.lineGross
                  "
                  class="font-semibold text-[var(--text-strong)]"
                >
                  El precio ha cambiado respecto al pedido original.
                </p>
                <p>
                  Precio vigente observado: {{ formatPrice(line.reorderOffer.unitGross) }} por unidad ·
                  {{ formatPrice(line.reorderOffer.lineGross) }} por línea (IVA incluido).
                </p>
                <p>
                  Sin IVA: {{ formatPrice(line.reorderOffer.unitNet) }} por unidad ·
                  {{ formatPrice(line.reorderOffer.lineNet) }} por línea. IVA
                  {{ line.reorderOffer.taxRateBasisPoints / 100 }} %.
                </p>
                <p>
                  Límites vigentes: mínimo {{ line.reorderOffer.minimumQuantity }},
                  {{
                    line.reorderOffer.maximumQuantity === null
                      ? 'sin máximo'
                      : `máximo ${line.reorderOffer.maximumQuantity}`
                  }}, incremento {{ line.reorderOffer.quantityIncrement }}.
                </p>
                <p>
                  Disponibilidad observada: {{ line.reorderOffer.availableQuantity }} unidades como máximo en una
                  ubicación activa.
                  <span v-if="line.reorderOffer.backorderAllowed">Venta bajo pedido admitida.</span>
                  No reserva stock ni garantiza el precio al añadir.
                </p>
              </div>
            </div>
            <span class="tabular shrink-0 text-sm font-semibold">× {{ line.quantity }}</span>
          </li>
        </ul>

        <div
          v-if="reorder.unavailableLines.value.length"
          class="rounded-[var(--radius-surface)] border border-amber-200 bg-amber-50 p-3"
        >
          <p class="text-sm font-semibold text-amber-900">
            {{ reorder.unavailableLines.value.length }}
            {{
              reorder.unavailableLines.value.length === 1
                ? 'referencia no se puede añadir'
                : 'referencias no se pueden añadir'
            }}
          </p>
          <ul class="mt-2 space-y-1">
            <li v-for="line in reorder.unavailableLines.value" :key="line.sku" class="text-sm text-amber-900">
              {{ line.name }} × {{ line.quantity }} — {{ reorder.unavailableReason(line) }}
              <p v-if="line.reorderOffer" class="text-xs">
                Límites vigentes: mínimo {{ line.reorderOffer.minimumQuantity }},
                {{
                  line.reorderOffer.maximumQuantity === null
                    ? 'sin máximo'
                    : `máximo ${line.reorderOffer.maximumQuantity}`
                }}, incremento {{ line.reorderOffer.quantityIncrement }}. Disponibilidad observada:
                {{ line.reorderOffer.availableQuantity }} unidades como máximo en una ubicación activa. No reserva
                stock.
              </p>
            </li>
          </ul>
        </div>

        <UAlert v-if="reorder.error.value" role="alert" color="error" variant="subtle" :title="reorder.error.value" />
      </div>

      <UAlert
        v-else-if="reorder.error.value"
        role="alert"
        color="error"
        variant="subtle"
        :title="reorder.error.value"
      />
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton type="button" color="neutral" variant="ghost" @click="reorder.close()">Cancelar</UButton>
        <UButton v-if="reorder.canRetry.value" type="button" icon="i-lucide-refresh-cw" @click="reorder.retry()">
          Reintentar lectura del pedido
        </UButton>
        <UButton
          v-else
          type="button"
          :disabled="reorder.adding.value || !reorder.availableLines.value.length"
          :loading="reorder.adding.value"
          icon="i-lucide-shopping-cart"
          @click="confirm"
        >
          Añadir {{ reorder.availableLines.value.length }} al carrito
        </UButton>
      </div>
    </template>
  </UModal>
</template>
