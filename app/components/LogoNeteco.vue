<script setup lang="ts">
defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>()
</script>

<template>
  <div
    class="flex flex-col items-center"
    :class="{
      'scale-50': size === 'sm',
      'scale-75': size === 'md',
      'scale-100': size === 'lg'
    }"
  >
    <svg
      viewBox="0 0 200 180"
      class="w-32 h-auto"
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- Figura humana abstracta -->
      <g transform="translate(50, 0)">
        <!-- Cabeza -->
        <ellipse cx="70" cy="12" rx="10" ry="12" fill="#7EC8E3"/>
        <!-- Brazo izquierdo -->
        <ellipse cx="30" cy="25" rx="8" ry="18" fill="#7EC8E3" transform="rotate(-45 30 25)"/>
        <!-- Brazo derecho -->
        <ellipse cx="85" cy="8" rx="6" ry="14" fill="#7EC8E3" transform="rotate(30 85 8)"/>
        <!-- Cuerpo/Pierna -->
        <ellipse cx="55" cy="70" rx="8" ry="35" fill="#7EC8E3" transform="rotate(15 55 70)"/>
      </g>

      <!-- Texto NETECO -->
      <g transform="translate(0, 120)">
        <!-- N -->
        <text x="0" y="40" font-family="Arial, sans-serif" font-size="42" font-weight="300" fill="#B8E2F2">N</text>
        <!-- E -->
        <text x="28" y="40" font-family="Arial, sans-serif" font-size="42" font-weight="300" fill="#B8E2F2">E</text>
        <!-- T -->
        <text x="56" y="40" font-family="Arial, sans-serif" font-size="42" font-weight="300" fill="#B8E2F2">T</text>
        <!-- E -->
        <text x="84" y="40" font-family="Arial, sans-serif" font-size="42" font-weight="400" fill="#5BA4C9">E</text>
        <!-- C -->
        <text x="112" y="40" font-family="Arial, sans-serif" font-size="42" font-weight="400" fill="#5BA4C9">C</text>
        <!-- O con gota -->
        <g transform="translate(140, 0)">
          <!-- Círculo exterior -->
          <circle cx="22" cy="26" r="20" fill="none" stroke="#4A90B8" stroke-width="3"/>
          <!-- Gota interior -->
          <path d="M22 12 C22 12 14 22 14 28 C14 33 17 36 22 36 C27 36 30 33 30 28 C30 22 22 12 22 12" fill="#4A90B8"/>
        </g>
      </g>
    </svg>
  </div>
</template>
