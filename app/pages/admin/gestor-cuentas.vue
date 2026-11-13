<script setup lang="ts">
import { ref } from 'vue'
import AdminCustomerAccountManager from '../../components/AdminCustomerAccountManager.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Gestores de cuenta · Admin', robots: 'noindex, nofollow, noarchive' })

const selectedCustomerId = ref('30000000-0000-4000-8000-000000000046')
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <div class="adm-card adm-tablecard">
        <div class="adm-tablecard__bar">
          <div class="adm-toolbar">
            <label for="account-manager-customer" class="adm-label">Cliente</label>
            <input
              id="account-manager-customer"
              v-model="selectedCustomerId"
              type="text"
              placeholder="Identificador del cliente"
              class="min-w-0 flex-1 sm:max-w-sm"
            />
          </div>
        </div>
      </div>
      <AdminCustomerAccountManager :customer-id="selectedCustomerId" />
    </div>
  </AdminPage>
</template>
