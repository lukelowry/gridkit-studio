import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    projects: [
      // Beside the code they test, and run everywhere.
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          clearMocks: true,
        },
      },
      // GridKit's own DynamicSimulation, run where GridKit is installed.
      {
        test: {
          name: 'simulation',
          environment: 'node',
          include: ['tests/simulation/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
})
