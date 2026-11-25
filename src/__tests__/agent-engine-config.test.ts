import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  get PROJECT_ROOT() { return h.root },
}))

h.root = mkdtempSync(join(tmpdir(), 'agent-engine-'))
const { readAgentEngine } = await import('../web/agent-config.js')
const configPath = join(h.root, 'agents', 'test-agent', 'agent-config.json')

beforeEach(() => {
  rmSync(join(h.root, 'agents'), { recursive: true, force: true })
  mkdirSync(join(h.root, 'agents', 'test-agent'), { recursive: true })
})
afterAll(() => rmSync(h.root, { recursive: true, force: true }))

describe('readAgentEngine', () => {
  it('reads codex and re-reads changes without caching', () => {
    writeFileSync(configPath, '{"engine":"codex"}')
    expect(readAgentEngine('test-agent')).toBe('codex')
    writeFileSync(configPath, '{"engine":"claude"}')
    expect(readAgentEngine('test-agent')).toBe('claude')
  })

  it('defaults to claude for a missing file', () => {
    expect(readAgentEngine('test-agent')).toBe('claude')
  })

  it.each(['{}', '{"engine":"other"}', '{invalid json', 'null'])(
    'defaults to claude for %s', (config) => {
      writeFileSync(configPath, config)
      expect(readAgentEngine('test-agent')).toBe('claude')
    },
  )
})
