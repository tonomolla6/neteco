export default {
  testRunner: 'vitest',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.stryker.json',
  disableTypeChecks: false,
  mutate: [
    'server/domain/**/*.ts',
    'server/integrations/**/*.ts',
    '!server/integrations/carrier-provider.ts',
    '!server/integrations/invoice-provider.ts',
    '!server/integrations/payment-provider.ts'
  ],
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  inPlace: true,
  incremental: false,
  cleanTempDir: 'always',
  tempDirName: '.stryker-tmp',
  // The initial run executes the whole vitest suite; on the 3-CPU Oracle runner it exceeds the 5 min default.
  dryRunTimeoutMinutes: 30
}
