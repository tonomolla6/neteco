export default defineNitroPlugin(() => {
  validateRuntimeConfiguration(useRuntimeConfig())
})
