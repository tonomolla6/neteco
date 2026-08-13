<script setup lang="ts">
useSeoMeta({
  title: 'Contacto y soporte',
  description: 'Contacta con NETECO sobre productos, pedidos, entregas, pagos, facturas, devoluciones o tu cuenta.'
})

const route = useRoute()
const { user } = useUserSession()
const form = reactive({
  name: user.value?.name ?? '',
  email: user.value?.email ?? '',
  phone: user.value?.phone ?? '',
  category: route.query.producto ? 'product' : route.query.pedido ? 'order' : 'other',
  subject: route.query.producto ? `Consulta sobre ${String(route.query.producto)}` : '',
  message: '',
  orderNumber: String(route.query.pedido ?? ''),
  productSlug: String(route.query.producto ?? ''),
  privacyAcknowledged: false,
  website: ''
})
const submitting = ref(false)
const errorMessage = ref('')
const ticket = ref<{ id: string; status: string } | null>(null)

async function submit() {
  errorMessage.value = ''
  submitting.value = true
  try {
    ticket.value = await $fetch('/api/support/tickets', { method: 'POST', body: form })
  } catch (error) {
    errorMessage.value = apiErrorMessage(
      error,
      'No hemos podido registrar la consulta. Puedes llamarnos al 600 861 334.'
    )
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-10">
    <h1 class="text-3xl font-bold text-slate-900">Contacto y soporte</h1>
    <p class="mt-2 text-slate-600">
      Cuéntanos qué necesitas. Registraremos tu consulta con una referencia para que no se pierda el contexto.
    </p>

    <UAlert
      v-if="ticket"
      class="mt-6"
      color="success"
      variant="subtle"
      icon="i-lucide-circle-check"
      title="Consulta registrada"
      :description="`Referencia ${ticket.id}. Conserva este número si vuelves a contactar.`"
    />

    <form v-else class="mt-8 space-y-5 rounded-2xl border border-slate-200 bg-white p-6" @submit.prevent="submit">
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Nombre" required>
          <UInput v-model="form.name" autocomplete="name" class="w-full" required />
        </UFormField>
        <UFormField label="Email" required>
          <UInput v-model="form.email" type="email" autocomplete="email" class="w-full" required />
        </UFormField>
        <UFormField label="Teléfono" hint="opcional">
          <UInput v-model="form.phone" type="tel" autocomplete="tel" class="w-full" />
        </UFormField>
        <UFormField label="Motivo" required>
          <select
            v-model="form.category"
            class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neteco-500"
          >
            <option value="product">Producto o documentación</option>
            <option value="order">Pedido</option>
            <option value="shipping">Envío o entrega</option>
            <option value="payment">Pago</option>
            <option value="invoice">Factura</option>
            <option value="return">Devolución</option>
            <option value="account">Cuenta</option>
            <option value="other">Otra consulta</option>
          </select>
        </UFormField>
        <UFormField label="Número de pedido" hint="opcional">
          <UInput v-model="form.orderNumber" class="w-full" placeholder="NE…" />
        </UFormField>
        <UFormField label="Producto" hint="opcional">
          <UInput v-model="form.productSlug" class="w-full" />
        </UFormField>
      </div>
      <UFormField label="Asunto" required>
        <UInput v-model="form.subject" class="w-full" required minlength="5" />
      </UFormField>
      <UFormField label="Mensaje" required>
        <UTextarea v-model="form.message" :rows="7" class="w-full" required minlength="10" maxlength="5000" />
      </UFormField>
      <div class="sr-only" aria-hidden="true">
        <label>Web <input v-model="form.website" tabindex="-1" autocomplete="off" /></label>
      </div>
      <label class="flex items-start gap-2 text-sm text-slate-600">
        <input v-model="form.privacyAcknowledged" type="checkbox" required class="mt-1 accent-neteco-600" />
        <span>
          He leído la
          <a href="https://neteco.es/legal" target="_blank" rel="noopener" class="underline"
            >información de privacidad</a
          >
          aplicable a esta consulta.
        </span>
      </label>
      <UAlert v-if="errorMessage" color="error" variant="subtle" role="alert" :title="errorMessage" />
      <UButton type="submit" size="lg" :loading="submitting" icon="i-lucide-send">Enviar consulta</UButton>
    </form>
  </div>
</template>
