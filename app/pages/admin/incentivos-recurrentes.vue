<script setup lang="ts">
import { ref } from 'vue'
import AdminRecurringIncentivesPanel from '~/components/AdminRecurringIncentivesPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Incentivos por recurrencia B2B · Admin', robots: 'noindex, nofollow, noarchive' })

const companyId = ref('comp-turia')
const appliedCompanyId = ref('comp-turia')

function updateCompany() {
  if (companyId.value.trim()) {
    appliedCompanyId.value = companyId.value.trim()
  }
}
</script>

<template>
  <AdminPage>
    <div class="adm-stack">
      <div class="adm-card">
        <div class="adm-card__body">
          <div class="adm-toolbar">
            <label for="company-picker" class="adm-label">Empresa</label>
            <input
              id="company-picker"
              v-model="companyId"
              data-test="company-input"
              type="text"
              class="adm-input w-auto min-w-0 flex-1 sm:max-w-xs"
              placeholder="Identificador de la empresa, p. ej. comp-turia"
              @keyup.enter="updateCompany"
            />
            <AdminButton icon="i-lucide-search" @click="updateCompany">Ver acuerdo</AdminButton>
          </div>
        </div>
      </div>

      <AdminRecurringIncentivesPanel :key="appliedCompanyId" :company-id="appliedCompanyId" />
    </div>
  </AdminPage>
</template>
