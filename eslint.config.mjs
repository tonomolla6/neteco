import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    ignores: [
      '.cache/**',
      '.nuxt/**',
      '.output/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      'worker-configuration.d.ts'
    ]
  },
  {
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      'vue/html-self-closing': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-mutating-props': 'error'
    }
  }
)
