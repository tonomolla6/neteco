<script setup lang="ts">
import type { OrderLine } from '~/composables/useAccount'

/**
 * «Guardar como lista»: el pedido que se acaba de hacer suele ser el que se repetirá.
 * Se guardan las líneas que siguen a la venta, cada una con su cantidad. Donde hay listas
 * con nombre (Cloudflare) se crea una lista «Pedido …»; si no, va a la lista única.
 */
const props = defineProps<{ orderId: string; lines: OrderLine[]; cloudflare: boolean }>()

const saving = ref(false)
const saved = ref<number | null>(null)
const skipped = ref(0)
const errorMsg = ref('')

function statusCode(error: unknown) {
  const failure = error && typeof error === 'object' ? (error as { statusCode?: unknown; status?: unknown }) : null
  return Number(failure?.statusCode ?? failure?.status)
}

async function save() {
  if (saving.value) return
  saving.value = true
  errorMsg.value = ''
  saved.value = null
  const savable = props.lines.filter((line) => line.available && line.variantId !== null)
  try {
    let listId: string | undefined
    if (props.cloudflare) {
      const list = await $fetch<{ id: string }>('/api/account/favorites/lists', {
        method: 'POST',
        body: { name: `Pedido ${props.orderId}` }
      })
      listId = list.id
    }
    let count = 0
    for (const line of savable) {
      try {
        await $fetch('/api/account/favorites', {
          method: 'POST',
          body: { variantId: line.variantId, quantity: line.quantity, ...(listId ? { listId } : {}) }
        })
        count++
      } catch {
        /* Una referencia que ya no se vende no impide guardar las demás. */
      }
    }
    saved.value = count
    skipped.value = props.lines.length - count
  } catch (error) {
    errorMsg.value =
      statusCode(error) === 409
        ? 'Ya tienes una lista de este pedido. Puedes verla en Listas.'
        : 'No hemos podido guardar la lista. Inténtalo de nuevo.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <UButton
      block
      color="neutral"
      variant="outline"
      icon="i-lucide-list-plus"
      data-order-save-list
      :loading="saving"
      :disabled="saved !== null"
      @click="save"
    >
      Guardar como lista
    </UButton>
    <p v-if="saved !== null" data-order-save-list-status role="status" class="mt-2 text-sm text-[var(--text)]">
      Guardado en tus listas: {{ saved }} {{ saved === 1 ? 'referencia' : 'referencias' }}.
      <template v-if="skipped">
        {{ skipped }} {{ skipped === 1 ? 'ya no está disponible' : 'ya no están disponibles' }}.
      </template>
      <NuxtLink to="/cuenta/listas" class="font-semibold text-[var(--link)] underline">Ver listas</NuxtLink>
    </p>
    <p v-if="errorMsg" role="alert" class="mt-2 text-sm text-red-700">{{ errorMsg }}</p>
  </div>
</template>
