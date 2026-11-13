<script setup lang="ts">
import AdminWelcomeCoupon from '~/components/AdminWelcomeCoupon.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Cupón de bienvenida · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminWelcomeCoupon />
  </AdminPage>
</template>
