import { beforeEach, describe, expect, it, vi } from 'vitest'

// Reuse the child_process seam from send-prompt-chunk-binding: no real tmux runs.
const h = vi.hoisted(() => {
  const sep = '─'.repeat(80)
  const pane = (typed: string) => ['', sep, '❯ ' + typed, sep,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
  return { pane, typed: '', calls: [] as string[][], ignoreSubmits: 0 }
})

vi.mock('node:child_process', async (orig) => ({
  ...(await orig() as object),
  execFileSync: vi.fn((_file: string, args?: string[]) => {
    if (Array.isArray(args)) {
      h.calls.push(args)
      if (args.includes('capture-pane')) return h.pane(h.typed)
      if (args.includes('send-keys')) {
        if (args.includes('-l')) h.typed += args[args.indexOf('-l') + 1]
        else if (['Enter', 'Tab'].includes(args[args.length - 1])) {
          if (h.ignoreSubmits > 0) h.ignoreSubmits--
          else h.typed = ''
        }
      }
    }
    return ''
  }),
}))
vi.mock('../notify.js', () => ({ notifyChannel: vi.fn(async () => {}), notifyTelegram: vi.fn(async () => {}) }))

import { sendPromptToSession } from '../web/agent-process.js'
import { __resetSessionSendLocks } from '../web/session-send-lock.js'

beforeEach(() => {
  h.typed = ''
  h.calls.length = 0
  h.ignoreSubmits = 0
  __resetSessionSendLocks()
})

describe('sendPromptToSession engine submit key', () => {
  it.each([
    ['codex', 'Tab'], ['claude', 'Enter'], [undefined, 'Enter'],
  ])('uses %s engine submit key %s for initial submit and retry', async (engine, key) => {
    // Keep the first submit parked, forcing the real retry loop to press again.
    h.ignoreSubmits = 1
    expect(await sendPromptToSession('engine-submit-test', 'engine submit prompt', null,
      { waitForIdle: false, ...(engine === undefined ? {} : { engine }) })).toBe('sent')

    const typedAt = h.calls.findIndex((args) => args.includes('send-keys') && args.includes('-l'))
    expect(typedAt).toBeGreaterThanOrEqual(0)
    // Only nonliteral keys AFTER typing are prompt submits; modal keys precede typing.
    const submits = h.calls.slice(typedAt + 1)
      .filter((args) => args.includes('send-keys') && !args.includes('-l'))
    expect(submits).toEqual([
      ['send-keys', '-t', '=engine-submit-test:', key],
      ['send-keys', '-t', '=engine-submit-test:', key],
    ])
  })
})
