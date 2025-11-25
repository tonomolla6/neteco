<script setup lang="ts">
const isLoading = ref(true)

onMounted(() => {
  setTimeout(() => {
    isLoading.value = false
  }, 300)
})
</script>

<template>
  <Transition name="fade">
    <div
      v-if="isLoading"
      class="fixed inset-0 z-[9999] bg-white flex flex-col items-center justify-center"
    >
      <div class="flex flex-col items-center gap-4">
        <div class="flex flex-col leading-none">
          <span class="text-4xl font-bold text-sky-600 tracking-wide">NETECO</span>
          <span class="text-[10px] text-slate-400 uppercase tracking-[0.2em] text-center">Suministros</span>
        </div>
        <div class="flex gap-1 mt-4">
          <span class="w-2 h-2 bg-sky-600 rounded-full animate-bounce" style="animation-delay: 0ms"></span>
          <span class="w-2 h-2 bg-sky-600 rounded-full animate-bounce" style="animation-delay: 150ms"></span>
          <span class="w-2 h-2 bg-sky-600 rounded-full animate-bounce" style="animation-delay: 300ms"></span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-leave-to {
  opacity: 0;
}
</style>
