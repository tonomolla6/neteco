<script setup lang="ts">
/** Aviso común de las pantallas de Ajustes: son de consulta y se cambian en el entorno. */
defineProps<{ failed?: boolean }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="adm-settings-notice" role="note">
    <UIcon name="i-lucide-lock-keyhole" class="mt-0.5 size-4 shrink-0" />
    <p>
      <strong>Solo consulta.</strong> Estos ajustes se configuran en el entorno de la tienda: aquí ves el valor en vigor
      y, junto a cada uno, el nombre de la variable donde se cambia. Las claves y contraseñas nunca se muestran.
    </p>
  </div>
  <UAlert
    v-if="failed"
    color="warning"
    variant="subtle"
    icon="i-lucide-cloud-off"
    title="No hemos podido leer parte de la configuración"
    description="Los datos del servidor (pagos, facturación y correo) no están disponibles ahora mismo."
    :actions="[{ label: 'Reintentar', color: 'neutral', variant: 'outline', onClick: () => $emit('retry') }]"
  />
</template>
