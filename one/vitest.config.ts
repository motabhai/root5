import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: '.',
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts']
  }
})
