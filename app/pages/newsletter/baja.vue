<script setup lang="ts">
import { useNewsletterLinkAction } from '~/composables/useNewsletterLinkAction'

useSeoMeta({ title: 'Baja de newsletter · NETECO', robots: 'noindex, nofollow' })
useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
const { status, message, submit: unsubscribe } = useNewsletterLinkAction('unsubscribe')
</script>

<template>
  <main class="mx-auto max-w-xl px-4 py-20 text-center" :aria-busy="status === 'loading'">
    <UIcon name="i-lucide-mail-x" class="mx-auto size-12 text-neteco-600" />
    <h1 class="mt-4 text-3xl font-bold text-slate-900">Dejar de recibir la newsletter</h1>
    <p class="mt-3 text-slate-600">
      La baja comercial es inmediata y no afecta a emails de pedidos, facturas o seguridad.
    </p>
    <UButton v-if="status === 'ready'" class="mt-6" size="lg" color="error" @click="unsubscribe"
      >Confirmar baja</UButton
    >
    <UButton v-else-if="status === 'loading'" class="mt-6" size="lg" loading disabled role="status">Procesando</UButton>
    <UAlert
      v-else-if="status === 'success'"
      class="mt-6 text-left"
      color="success"
      role="status"
      title="Solicitud procesada"
      description="Si el enlace era válido, la baja ya se ha aplicado. Si sigues recibiendo correos, usa el enlace del último mensaje o contacta con soporte."
    />
    <template v-else>
      <UAlert
        class="mt-6 text-left"
        color="error"
        role="alert"
        title="No se ha podido tramitar"
        :description="message"
      />
      <UButton v-if="status === 'error'" class="mt-6" size="lg" color="error" @click="unsubscribe"
        >Reintentar baja</UButton
      >
    </template>
  </main>
</template>
