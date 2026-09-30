const path = require('path');

module.exports = {
  // Shares typed-array constructors with the test realm (onnxruntime-node checks them); see the ai-worker.
  testEnvironment: path.resolve(__dirname, '../../services/ai-worker/jest.environment.js'),
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [path.resolve(__dirname, '../../backend/node_modules/ts-jest'), { tsconfig: { ...require('./tsconfig.json').compilerOptions, rootDir: undefined } }],
  },
  moduleDirectories: ['node_modules', path.resolve(__dirname, '../../backend/node_modules')],
};
