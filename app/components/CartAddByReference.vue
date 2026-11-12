<script setup lang="ts">
import { useCartStore } from '~/stores/cart'
import { quickOrderQuantityRules, resolveQuickOrderReference } from '~~/shared/quick-order'

/**
 * Añadir por referencia desde el carrito: la versión de una línea del pedido rápido. Quien
 * repasa el carrito con el albarán delante añade la referencia que le falta sin salir.
 */
const cart = useCartStore()
const request = useRequestFetch()
const reference = ref('')
const quantity = ref(1)
const busy = ref(false)
const error = ref('')
const announcement = ref('')

async function add() {
  const value = reference.value.trim()
  if (!value || busy.value) return
  if (cart.pendingMutation || cart.blockedMutations) {
    error.value = 'Revisa primero la adición pendiente del carrito.'
    return
  }
  busy.value = true
  error.value = ''
  announcement.value = ''
  try {
    const found = await resolveQuickOrderReference(value, (async (path: string, options: object) =>
      request(path, options)) as never)
    if (found.status === 'error') {
      error.value = found.suggestion
        ? `${found.message} ¿Es ${found.suggestion.reference} · ${found.suggestion.name}?`
        : found.message
      return
    }
    const rules = quickOrderQuantityRules(found.variant)
    if (rules.maximumQuantity < rules.minimumQuantity) {
      error.value = 'Ahora mismo no tenemos existencias de esta referencia.'
      return
    }
    // La cantidad pedida se lleva a la cantidad válida más cercana de esa variante.
    const steps = Math.max(0, Math.round((quantity.value - rules.minimumQuantity) / rules.quantityIncrement))
    const reachable = Math.floor((rules.maximumQuantity - rules.minimumQuantity) / rules.quantityIncrement)
    const amount = rules.minimumQuantity + Math.min(steps, reachable) * rules.quantityIncrement
    await cart.add(
      {
        variantId: found.variant.id,
        slug: found.slug,
        name: found.name,
        sku: found.variant.sku,
        format: found.variant.format
      },
      amount
    )
    announcement.value = `${amount} × ${found.name} en el carrito`
    reference.value = ''
    quantity.value = 1
  } catch {
    error.value = cart.error || 'No se ha podido añadir. Vuelve a intentarlo.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form
    data-add-by-reference
    class="rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] p-3"
    @submit.prevent="add"
  >
    <div class="flex flex-wrap items-end gap-2">
      <div class="min-w-0 flex-1 basis-40">
        <label for="cart-reference" class="block text-[13px] font-medium text-[var(--text-muted)]">
          Añadir por referencia
        </label>
        <input
          id="cart-reference"
          v-model="reference"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="Referencia del albarán"
          class="tabular mt-1 h-11 w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-3 font-medium text-[var(--text-strong)]"
        />
      </div>
      <QuantityStepper v-model="quantity" label="la referencia" />
      <button
        type="submit"
        :disabled="busy || !reference.trim()"
        class="inline-flex h-11 items-center justify-center rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-[15px] font-semibold text-[var(--text-strong)] transition-colors hover:border-[var(--action)] hover:text-[var(--action)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ busy ? 'Añadiendo…' : 'Añadir' }}
      </button>
    </div>
    <p v-if="error" role="alert" class="mt-2 text-[13px] text-[var(--ui-error)]">{{ error }}</p>
    <p aria-live="polite" class="sr-only">{{ announcement }}</p>
  </form>
</template>
