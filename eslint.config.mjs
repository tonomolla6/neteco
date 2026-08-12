import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt({
  ignores: ['.cache/**', '.nuxt/**', '.output/**', 'coverage/**', 'node_modules/**', 'public/**'],
  rules: {
    '@typescript-eslint/no-dynamic-delete': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'off',
    'vue/html-self-closing': 'off',
    'vue/multi-word-component-names': 'off',
    'vue/no-mutating-props': 'warn'
  }
})
