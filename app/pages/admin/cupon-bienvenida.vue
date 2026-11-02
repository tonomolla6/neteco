<script setup lang="ts">
import AdminWelcomeCoupon from '~/components/AdminWelcomeCoupon.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Cupón de Bienvenida · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
    <AdminWelcomeCoupon />
  </div>
</template>
