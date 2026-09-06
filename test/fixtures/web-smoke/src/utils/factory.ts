import { Client } from './client'

// The client nobody constructs directly: a factory hands one out, and the
// module-level constant everything imports is whatever the factory returned.
export function make(options) {
  return new Client(options)
}

export const api = make({ timeout: 5000 })
