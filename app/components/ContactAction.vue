<script setup lang="ts">
/**
 * «llámanos al …» o, sin teléfono configurado, «escríbenos a …», con su enlace.
 * Para cerrar una frase de ayuda sin escribir a mano ningún dato de contacto.
 */
withDefaults(defineProps<{ capitalize?: boolean; linkClass?: string }>(), {
  capitalize: false,
  linkClass: 'font-semibold underline'
})
const { email, phone } = useCommercialTerms()
</script>

<template>
  <span data-contact-action
    ><template v-if="phone"
      >{{ capitalize ? 'Llámanos' : 'llámanos' }} al
      <a :href="phone.href" :class="linkClass">{{ phone.display }}</a></template
    ><template v-else
      >{{ capitalize ? 'Escríbenos' : 'escríbenos' }} a
      <a :href="`mailto:${email}`" :class="linkClass">{{ email }}</a></template
    ></span
  >
</template>
