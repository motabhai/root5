import { afterEach, vi } from 'vitest'
import MockD1 from './mock_db'

declare global {
  var __TEST_DB__: MockD1 | undefined
}

afterEach(async () => {
  // Clean up any mocks
  vi.restoreAllMocks()
  
  // Clean up test database if it exists
  if (globalThis.__TEST_DB__ && typeof globalThis.__TEST_DB__.teardown === 'function') {
    await globalThis.__TEST_DB__.teardown()
  }
})

export function makeTestEnv() {
  const db = new MockD1()
  globalThis.__TEST_DB__ = db
  return {
    CLOUDFLARE_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_ZONE_ID: 'zone-1',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    AUTH_TOKEN: 'test-token',
    DB: db
  } as any
}