export default {
  testRunner: 'vitest',
  checkers: ['typescript'],
  mutate: ['server/domain/**/*.ts', 'server/integrations/**/*.ts', '!**/*.test.ts'],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress', 'html'],
  tempDirName: '.stryker-tmp'
}
