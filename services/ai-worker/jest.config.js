const path = require('path');

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      path.resolve(__dirname, '../../backend/node_modules/ts-jest'),
      { tsconfig: '<rootDir>/tsconfig.json' },
    ],
  },
  moduleDirectories: ['node_modules', path.resolve(__dirname, '../../backend/node_modules')],
};
