module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json' }]
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  // Tests load ai-worker code (services/ai-worker/src), whose SDK copy imports zod; this job does not install
  // the worker's packages, so zod resolves to the backend's (tsconfig.json "paths" does the same for types).
  moduleNameMapper: { '^zod$': '<rootDir>/node_modules/zod' }
};
