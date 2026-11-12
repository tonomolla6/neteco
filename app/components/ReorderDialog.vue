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
  <!--
    Un pedido de treinta referencias no puede convertir el modal en una página: la altura queda
    acotada y la lista se desplaza dentro, con la cabecera y los botones siempre a la vista.
  -->
  <UModal
    v-model:open="open"
    title="Volver a pedir"
    :ui="{
      content: 'max-h-[min(40rem,calc(100dvh-2rem))] sm:max-w-xl',
      body: 'min-h-0 overflow-y-auto overscroll-contain [scrollbar-color:var(--border-strong)_transparent] [scrollbar-width:thin]'
    }"
  >
    <template #body>
      <div v-if="reorder.loading.value" role="status" aria-busy="true" class="space-y-3 py-2">
        <p class="sr-only">Preparando la repetición del pedido.</p>
        <div
          v-for="row in 3"
          :key="row"
          class="h-12 animate-pulse rounded-[var(--radius-surface)] bg-[var(--surface-sunken)]"
        />
      </div>

      <div v-else-if="reorder.plan.value" class="space-y-4" data-reorder-plan>
        <p v-if="reorder.addedCount.value" role="status" class="text-[13px] text-[var(--text)]">
          {{ reorder.addedCount.value }} líneas ya añadidas al carrito. No se volverán a añadir al reintentar.
        </p>
        <p class="text-[13px] text-[var(--text-muted)]">
          Pedido del {{ formatAccountDate(reorder.plan.value.orderedAt) }}. Se añaden con el precio de hoy; podrás
          cambiar las cantidades en el carrito.
        </p>

        <ul
          v-if="reorder.availableLines.value.length"
          class="divide-y divide-[var(--border)] rounded-[var(--radius-surface)] border border-[var(--border)]"
        >
          <li v-for="line in reorder.availableLines.value" :key="line.sku" class="flex items-center gap-3 p-3">
            <OrderLineThumb :line="line" size="sm" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-[15px] font-medium text-[var(--text-strong)]">{{ line.name }}</p>
              <p class="truncate text-[13px] text-[var(--text-muted)]">{{ line.format }} · Ref. {{ line.sku }}</p>
              <p class="tabular mt-0.5 text-[13px] text-[var(--text)]">
                {{ formatPrice(line.reorderOffer?.unitGross ?? line.unitGross) }}/ud
                <span
                  v-if="line.reorderOffer && line.reorderOffer.unitGross !== line.unitGross"
                  class="text-[var(--text-muted)]"
                >
                  · antes {{ formatPrice(line.unitGross) }}
                </span>
              </p>
            </div>
            <span class="tabular shrink-0 text-[15px] font-semibold text-[var(--text-strong)]"
              >× {{ line.quantity }}</span
            >
          </li>
        </ul>

        <div
          v-if="reorder.unavailableLines.value.length"
          class="rounded-[var(--radius-surface)] border border-amber-200 bg-amber-50 p-3"
        >
          <p class="text-[13px] font-semibold text-amber-900">
            {{ reorder.unavailableLines.value.length }}
            {{
              reorder.unavailableLines.value.length === 1
                ? 'referencia no se puede añadir'
                : 'referencias no se pueden añadir'
            }}
          </p>
          <ul class="mt-1.5 space-y-1">
            <li v-for="line in reorder.unavailableLines.value" :key="line.sku" class="text-[13px] text-amber-900">
              {{ line.name }} × {{ line.quantity }} — {{ reorder.unavailableReason(line) }}
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
