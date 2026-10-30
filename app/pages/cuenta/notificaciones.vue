<script setup lang="ts">
import AccountNotificationCenter from '../../components/AccountNotificationCenter.vue'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Centro de notificaciones', robots: 'noindex, nofollow' })
</script>

<template>
  <AccountNotificationCenter />
</template>
