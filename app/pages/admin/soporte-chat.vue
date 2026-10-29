<script setup lang="ts">
import AdminSupportLiveChat from '../../components/AdminSupportLiveChat.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Chat Humano en Vivo · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminSupportLiveChat />
</template>
