import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same mocked DB/sender harness as router-batch-inject; the real router chooses the path.
const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: number; from_agent: string; to_agent: string; content: string;
    created_at: number; urgent: number; trace_id: null; span_id: null; origin_note: null;
  }>,
  engines: new Map<string, string>(),
  readEngine: vi.fn<(name: string) => string>(),
  send: vi.fn(async (..._args: unknown[]) => 'sent' as const),
  delivered: vi.fn(() => true),
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin', SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))
vi.mock('../db.js', () => ({
  getPendingMessages: (to?: string) => h.rows.filter((row) => !to || row.to_agent === to),
  getMessageStatus: () => 'pending',
  markMessageDelivered: h.delivered,
  markMessageFailed: vi.fn(() => true),
  markMessageDone: vi.fn(() => true),
  markPendingFederatedFailed: vi.fn(() => true),
  setMessageResult: vi.fn(() => true),
  createAgentMessage: vi.fn(() => ({ id: 999 })),
  countNewerMessagesFromSameSender: () => 0,
  stampMessageTrace: () => false,
  upsertOtelSpan: vi.fn(),
  closeOtelSpan: () => false,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/agent-config.js', () => ({
  readAgentEngine: h.readEngine,
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
  readAgentPullDelivery: () => false,
}))
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: h.send,
  sessionExistsOnHost: () => true,
  capturePane: () => '',
}))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'payload' }),
}))
vi.mock('../web/delivery-turn-check.js', () => ({ scheduleDeliveryTurnCheck: vi.fn() }))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/telegram-inbox-wake.js', () => ({ maybeWakeSubAgentsForTelegram: vi.fn() }))

import { runMessageRouterTick } from '../web/message-router.js'

function queue(to: string, urgent = 0) {
  h.rows.push({
    id: h.rows.length + 1, from_agent: 'orin', to_agent: to, content: 'payload',
    created_at: Math.floor(Date.now() / 1000), urgent,
    trace_id: null, span_id: null, origin_note: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = []
  h.engines.clear()
  h.readEngine.mockImplementation((name) => h.engines.get(name) ?? 'claude')
  vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', 'nobody-opted-in')
})
afterEach(() => vi.unstubAllEnvs())

describe('router passes the cached target engine to the prompt sender', () => {
  it.each(['serial', 'batch', 'urgent'])('%s delivery passes codex or claude for the target', async (path) => {
    if (path === 'batch') vi.stubEnv('ROUTER_BATCH_INJECT_AGENTS', 'codex-agent,claude-agent')
    h.engines.set('codex-agent', 'codex')
    for (const target of ['codex-agent', 'claude-agent']) {
      queue(target, path === 'urgent' ? 1 : 0)
      if (path === 'batch') queue(target)
    }

    await runMessageRouterTick()

    expect(h.send).toHaveBeenCalledTimes(2)
    for (const [target, engine] of [['codex-agent', 'codex'], ['claude-agent', 'claude']]) {
      expect(h.send).toHaveBeenCalledWith(`agent-${target}`, expect.any(String), null,
        expect.objectContaining({ engine }))
    }
    expect(h.delivered).toHaveBeenCalledTimes(h.rows.length)
    expect(h.readEngine.mock.calls).toEqual([['codex-agent'], ['claude-agent']])
  })

  it('reads once per target per tick and refreshes on the next tick', async () => {
    h.engines.set('codex-agent', 'codex')
    queue('codex-agent')
    queue('codex-agent')
    await runMessageRouterTick()
    expect(h.readEngine).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(2)

    h.engines.set('codex-agent', 'claude')
    await runMessageRouterTick()
    expect(h.readEngine).toHaveBeenCalledTimes(2)
    expect(h.send).toHaveBeenLastCalledWith('agent-codex-agent', expect.any(String), null, { engine: 'claude' })
  })
})
