export default {
  testRunner: 'vitest',
  checkers: ['typescript'],
  tsconfigFile: '.nuxt/tsconfig.server.json',
  mutate: ['server/domain/**/*.ts', 'server/integrations/**/*.ts', '!**/*.test.ts'],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  inPlace: true,
  incremental: true,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp'
}
