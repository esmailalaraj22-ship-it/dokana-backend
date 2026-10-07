module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.integration-spec.ts'],
  setupFiles: ['dotenv/config'],
  globalTeardown: '<rootDir>/test/integration-global-teardown.ts',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  clearMocks: true,
  restoreMocks: true,
};
