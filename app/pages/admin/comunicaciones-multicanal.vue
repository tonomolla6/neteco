<script setup lang="ts">
import AdminMultichannelCommunications from '~/components/AdminMultichannelCommunications.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Comunicaciones multicanal · Admin', robots: 'noindex, nofollow, noarchive' })
</script>

<template>
  <AdminPage>
    <AdminMultichannelCommunications />
  </AdminPage>
</template>
