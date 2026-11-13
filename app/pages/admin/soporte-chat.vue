<script setup lang="ts">
import AdminSupportLiveChat from '../../components/AdminSupportLiveChat.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Chat con clientes · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminSupportLiveChat />
  </AdminPage>
</template>
