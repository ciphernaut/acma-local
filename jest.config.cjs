module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // Only ever scan tests/. Without this, jest walks gitignored scratch
  // directories and tries to run whatever test files it finds in them —
  // a checked-out reference repo under scratch/ will break the suite.
  roots: ['<rootDir>/tests'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
};