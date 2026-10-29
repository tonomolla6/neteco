<script setup lang="ts">
import { ref } from 'vue'
import AdminCustomerAccountManager from '../../components/AdminCustomerAccountManager.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Gestores de Cuenta y CRM · Admin', robots: 'noindex, nofollow, noarchive' })

const selectedCustomerId = ref('30000000-0000-4000-8000-000000000046')
</script>

<template>
  <div class="space-y-4">
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex items-center gap-3">
      <label class="text-xs font-semibold text-slate-700">ID Cliente / Cuenta:</label>
      <input
        v-model="selectedCustomerId"
        type="text"
        placeholder="UUID del cliente"
        class="rounded border border-slate-300 px-3 py-1 text-xs text-slate-900 w-96"
      />
    </div>
    <AdminCustomerAccountManager :customer-id="selectedCustomerId" />
  </div>
</template>
