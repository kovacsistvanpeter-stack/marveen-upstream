// scripts/patch-telegram-plugin.py (ELSOKOR922 spec D-4): takes /status and
// /help away from the Telegram channel plugin so the command hook can answer
// them. Run for real on a copy of the 0.0.7 plugin excerpt (verbatim blocks,
// fixtures/telegram-plugin-0.0.7/server.ts.txt) in a scratch plugins cache.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'
import { telegramPluginPatchStatus } from '../web/system-status.js'

const ROOT = join(__dirname, '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'patch-telegram-plugin.py')
const FIXTURE = join(__dirname, 'fixtures', 'telegram-plugin-0.0.7', 'server.ts.txt')

let cache = ''
let server = ''

beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), 'tg-plugin-cache-'))
  const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
  mkdirSync(dir, { recursive: true })
  server = join(dir, 'server.ts')
  copyFileSync(FIXTURE, server)
})
afterEach(() => rmSync(cache, { recursive: true, force: true }))

function run(extra: string[] = []): { status: number | null; stderr: string } {
  const r = spawnSync('python3', [SCRIPT, ...extra, cache], { encoding: 'utf-8', timeout: 30_000 })
  return { status: r.status, stderr: r.stderr }
}

function readState(file: string): { root: string; files: Array<{ version: string; path: string; status: string; patches: Record<string, string> }> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

function syntaxErrors(text: string): string[] {
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  return (out.diagnostics ?? []).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
}

describe('patch-telegram-plugin.py', () => {
  it('1st run patches: /help, /status handlers and the plugin menu gone, /start kept, still parses', () => {
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/patched .*server\.ts/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain("bot.command('help'")
    expect(text).not.toContain("bot.command('status'")
    expect(text).not.toContain('bot.api.setMyCommands(')
    expect(text).not.toContain('Paired as')
    expect(text).toContain("bot.command('start'")
    expect(text.match(/MARVEEN-PATCH\(elsokor922-d4\)/g)).toHaveLength(3)
    // the invis meta spread lands between user_id and the forwarded flag
    expect(text).toMatch(/ +user_id: String\(from\.id\),\n +\.\.\.__invis\.meta, \/\/ MARVEEN-PATCH\(invis1024\)[^\n]*\n +\.\.\.\(ctx\.message\?\.forward_origin \? \{ forwarded: '1' \} : \{\}\), \/\/ MARVEEN-PATCH\(elsokor922-fwd\)/)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('2nd run is a no-op: returns `already`, byte-identical, silent', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'patched', patches: { d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', invis: 'patched' } }])
    const once = readFileSync(server, 'utf-8')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(readFileSync(server, 'utf-8')).toBe(once)
    expect(readState(state).files).toEqual([{ version: '0.0.7', path: server, status: 'already', patches: { d4: 'already', fwd: 'already', evid: 'already', kbd: 'already', invis: 'already' } }])
  })

  it('a changed anchor (plugin update): loud line, THAT patch left out, the other still applied, exit 0', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace("bot.command('status', async ctx => {", "bot.command('status', async (ctx) => {")
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: status handler not found exactly once.*the d4 patch left out/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain('elsokor922-d4')
    expect(text).toContain("bot.command('help', async ctx => {")
    expect(text).toContain('elsokor922-fwd')
    expect(syntaxErrors(text)).toEqual([])
    expect(readState(state).files[0].patches).toEqual({ d4: 'anchor-missing:status handler', fwd: 'patched', evid: 'patched', kbd: 'patched', invis: 'patched' })
  })

  // #1530 review: owner write commands need evidence the owner's chat sent
  // them. The plugin records every inbound message just before handing it to
  // Claude Code -- the one place only a real Telegram update reaches.
  it('evid: one inbound-log line right before the channel notification, and it really writes the record', () => {
    run()
    const text = readFileSync(server, 'utf-8')
    expect(text.match(/MARVEEN-PATCH\(cmd920-evid\)/g)).toHaveLength(1)
    const lines = text.split('\n')
    const i = lines.findIndex(l => l.includes('MARVEEN-PATCH(cmd920-evid)'))
    // the invis1024 const line sits between the evidence line and the notification
    expect(lines[i + 1]).toMatch(/const __invis = /)
    expect(lines[i + 2]).toMatch(/^ *mcp\.notification\(\{$/)
    expect(lines[i + 3]).toMatch(/method: 'notifications\/claude\/channel',$/)
    expect(syntaxErrors(text)).toEqual([])
    // Run the inserted line with the handler's own names in scope.
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-evid-'))
    try {
      const fs = require('node:fs')
      const fn = new Function('writeFileSync', 'statSync', 'renameSync', 'join', 'STATE_DIR', 'chat_id', 'msgId', 'text', lines[i])
      fn(fs.writeFileSync, fs.statSync, fs.renameSync, join, stateDir, '42', 901, '/model opus')
      fn(fs.writeFileSync, fs.statSync, fs.renameSync, join, stateDir, '42', undefined, 'szia')
      const recs = readFileSync(join(stateDir, 'inbound-evidence.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
      expect(recs.map(r => [r.chat_id, r.message_id, r.text])).toEqual([['42', '901', '/model opus'], ['42', null, 'szia']])
      expect(typeof recs[0].at).toBe('number')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('evid: the permission notification (a different method) is not an anchor; a moved anchor leaves evid out loudly', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace("method: 'notifications/claude/channel',", "method: 'notifications/claude/channel/v2',")
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.stderr).toMatch(/LOUD: channel notification not found exactly once.*the evid patch left out, no inbound evidence is recorded/)
    expect(readState(state).files[0].patches.evid).toBe('anchor-missing:channel notification')
    expect(readFileSync(server, 'utf-8')).not.toContain('cmd920-evid')
  })

  it('a file patched by the d4-only version gets the forward patch on the next run', () => {
    run()
    const d4only = readFileSync(server, 'utf-8').replace(/\n +\.\.\.\(ctx\.message\?\.forward_origin[^\n]*/, '')
    writeFileSync(server, d4only)
    expect(d4only).not.toContain('elsokor922-fwd')
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(fwd\)/)
    expect(readFileSync(server, 'utf-8').match(/elsokor922-fwd/g)).toHaveLength(1)
  })

  it('writes exactly one cache: $CLAUDE_CONFIG_DIR when set, the user-level ~/.claude never on top', () => {
    const home = mkdtempSync(join(tmpdir(), 'tg-plugin-home-'))
    try {
      const userDir = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(userDir, { recursive: true })
      const userServer = join(userDir, 'server.ts')
      copyFileSync(FIXTURE, userServer)
      // cache = <cfg>/plugins/cache, so its config dir is two levels up
      const cfg = join(cache, 'cfg')
      const cfgDir = join(cfg, 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(cfgDir, { recursive: true })
      const cfgServer = join(cfgDir, 'server.ts')
      copyFileSync(FIXTURE, cfgServer)
      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: cfg }
      const r = spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env })
      expect(r.status).toBe(0)
      expect(readFileSync(cfgServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
      expect(readFileSync(userServer, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
      // without CLAUDE_CONFIG_DIR the user-level cache IS the launch cache
      const { CLAUDE_CONFIG_DIR: _unset, ...noCfg } = env
      spawnSync('python3', [SCRIPT], { encoding: 'utf-8', env: noCfg })
      expect(readFileSync(userServer, 'utf-8')).toContain('MARVEEN-PATCH(elsokor922-d4)')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('no plugin cache at all: exit 0, nothing to do', () => {
    const r = spawnSync('python3', [SCRIPT, join(cache, 'does-not-exist')], { encoding: 'utf-8' })
    expect(r.status).toBe(0)
  })

  it('an unwritable file: named in the log, exit 0 (the channel still starts)', () => {
    const dir = join(cache, 'claude-plugins-official', 'telegram', '0.0.7')
    spawnSync('chmod', ['a-w', dir])
    try {
      const r = run()
      expect(r.status).toBe(0)
      expect(r.stderr).toMatch(/cannot write .*left unpatched/)
      expect(readFileSync(server, 'utf-8')).toBe(readFileSync(FIXTURE, 'utf-8'))
    } finally {
      spawnSync('chmod', ['u+w', dir])
    }
  })
})

// c67f5f34: one-tap answer buttons (a reply keyboard) on the reply tool. The inbound side needs nothing: a tapped
// text-only button arrives as the user's ordinary text message. So three marked lines in the reply tool: the schema
// field, its check before anything is sent, and the keyboard on the LAST text chunk.
const KBD = 'MARVEEN-PATCH(c67f5f34-kbd)'

// The fixture patched by the script WITHOUT the kbd patch (the state a file had before this change).
function patchedWithoutKbd(text: string): string {
  const code = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('ptp', sys.argv[1])",
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    "m.PATCHES = [p for p in m.PATCHES if p['name'] != 'kbd']",
    'sys.stdout.write(m.patch_text(sys.stdin.read())[0])',
  ].join('\n')
  const r = spawnSync('python3', ['-c', code, SCRIPT], { input: text, encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout
}

type Sent = { chat: string; text: string; opts: Record<string, unknown> }

// Runs the PATCHED tool-call handler of the fixture (the verbatim 0.0.7 block) with a fake bot: what the reply tool
// really passes to sendMessage. Only the reply case runs; the names the other cases use are never evaluated.
function replyHandler(patched: string): { call: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>; sent: Sent[] } {
  const start = patched.indexOf('mcp.setRequestHandler(CallToolRequestSchema')
  expect(start).toBeGreaterThan(0)
  const js = ts.transpileModule(patched.slice(start), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: Sent[] = []
  let handler: ((req: unknown) => Promise<never>) | undefined
  const mcp = { setRequestHandler: (_schema: unknown, fn: (req: unknown) => Promise<never>) => { handler = fn } }
  const bot = { api: { sendMessage: async (chat: string, text: string, opts: Record<string, unknown>) => { sent.push({ chat, text, opts }); return { message_id: sent.length } } } }
  const names = ['mcp', 'CallToolRequestSchema', 'assertAllowedChat', 'assertSendable', 'statSync', 'MAX_ATTACHMENT_BYTES',
    'loadAccess', 'MAX_CHUNK_LIMIT', 'chunk', 'bot', 'extname', 'InputFile', 'PHOTO_EXTS']
  new Function(...names, js)(mcp, {}, () => {}, () => {}, () => ({ size: 0 }), 50 * 1024 * 1024,
    () => ({}), 4096, (text: string) => text.split('|'), bot, () => '', class {}, new Set())
  expect(handler).toBeDefined()
  return { call: args => handler!({ params: { name: 'reply', arguments: args } }), sent }
}

describe('kbd: reply-keyboard buttons (c67f5f34)', () => {
  it('three marked lines, the buttons field inside the reply tool schema, and the file still parses', () => {
    expect(run().status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    const lines = text.split('\n').filter(l => l.includes(KBD))
    expect(lines).toHaveLength(3)
    const reply = text.indexOf("name: 'reply'")
    const react = text.indexOf("name: 'react'")
    const field = text.indexOf("buttons: { type: 'array'")
    expect(field).toBeGreaterThan(reply)
    expect(field).toBeLessThan(text.indexOf("required: ['chat_id', 'text'],", reply))
    expect(react).toBeGreaterThan(field)
    expect(syntaxErrors(text)).toEqual([])
  })

  it('the reply sends the keyboard on the LAST chunk only, one label per row, hidden after one tap', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const res = await h.call({ chat_id: '42', text: 'Első rész|A: elfogadod, B: már megoldva, C: más megoldás?', buttons: ['A. Elfogadom', 'B. Már megoldva', 'C. Valami más lesz a megoldás'] })
    expect(res.isError).toBeUndefined()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[0].opts).not.toHaveProperty('reply_markup')
    expect(h.sent[1].opts.reply_markup).toEqual({
      keyboard: [[{ text: 'A. Elfogadom' }], [{ text: 'B. Már megoldva' }], [{ text: 'C. Valami más lesz a megoldás' }]],
      one_time_keyboard: true,
      resize_keyboard: true,
    })
  })

  it('an empty list removes a keyboard shown earlier; no buttons means no reply_markup at all', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    await h.call({ chat_id: '42', text: 'Köszönöm, rögzítettem.', buttons: [] })
    expect(h.sent[0].opts.reply_markup).toEqual({ remove_keyboard: true })
    await h.call({ chat_id: '42', text: 'Sima válasz|két részben' })
    expect(h.sent.slice(1).map(s => 'reply_markup' in s.opts)).toEqual([false, false])
  })

  it('a bad buttons value is a tool error BEFORE anything is sent', async () => {
    run()
    const h = replyHandler(readFileSync(server, 'utf-8'))
    const bad: unknown[] = ['A', [''], ['   '], [1], ['x'.repeat(65)], Array.from({ length: 13 }, (_, i) => `${i}`)]
    for (const buttons of bad) {
      const res = await h.call({ chat_id: '42', text: 'Kérdés', buttons })
      expect(res.isError).toBe(true)
      expect(res.content[0].text).toMatch(/^reply failed: buttons: /)
    }
    expect(h.sent).toHaveLength(0)
    // the limits themselves are accepted
    const ok = await h.call({ chat_id: '42', text: 'Kérdés', buttons: [...Array.from({ length: 11 }, (_, i) => `${i}`), 'x'.repeat(64)] })
    expect(ok.isError).toBeUndefined()
  })

  it('taking it back = deleting the marked lines: byte-identical to the file patched without kbd', () => {
    run()
    const withKbd = readFileSync(server, 'utf-8')
    const back = withKbd.split('\n').filter(l => !l.includes(KBD)).join('\n')
    expect(back).toBe(patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    expect(back).not.toContain(KBD)
  })

  it('all or nothing: one moved kbd anchor leaves all three lines out, loudly; the other patches still applied', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('...(parseMode ? { parse_mode: parseMode } : {}),', '...(parseMode ? { parse_mode: parseMode } : undefined),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: reply send options not found exactly once.*the kbd patch left out, the reply tool has no buttons/)
    expect(readFileSync(server, 'utf-8')).not.toContain(KBD)
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'anchor-missing:reply send options', invis: 'patched' })
  })

  it('a file patched by the previous version (d4, fwd, evid) gets kbd on the next run', () => {
    writeFileSync(server, patchedWithoutKbd(readFileSync(FIXTURE, 'utf-8')))
    const r = run()
    expect(r.stderr).toMatch(/patched .*\(kbd\)/)
    expect(readFileSync(server, 'utf-8').split('\n').filter(l => l.includes(KBD))).toHaveLength(3)
  })
})

// invis1024: a forwarded or pasted text can carry characters a person cannot see but the model reads
// (Unicode tag characters, "ASCII smuggling") or that reorder what the reader sees (bidi controls).
// The patched handler hands the model the stripped text and says per class how many went -- the same
// rule as the Teams plugin. The evidence line, written just before, still holds the RAW text.
describe('invis: invisible characters (invis1024)', () => {
  const INVIS = 'MARVEEN-PATCH(invis1024)'

  it('1st run patches: exactly three marked lines, the file still parses, the evidence line stays first', () => {
    expect(run().status).toBe(0)
    const text = readFileSync(server, 'utf-8')
    expect(text.match(/MARVEEN-PATCH\(invis1024\)/g)).toHaveLength(3)
    // the const line sits after the evidence line (which keeps the RAW text) and before the notification
    const lines = text.split('\n')
    const evid = lines.findIndex(l => l.includes('MARVEEN-PATCH(cmd920-evid)'))
    const invis = lines.findIndex(l => l.includes('const __invis ='))
    expect(evid).toBeGreaterThan(-1)
    expect(invis).toBe(evid + 1)
    expect(lines[evid]).toContain('mode: 0o600')
    expect(lines[invis + 1]).toMatch(/^ *mcp\.notification\(\{$/)
    // the content spread overrides `content: text`, the meta spread lands right after user_id
    expect(text).toMatch(/content: text,\n +\.\.\.\{ content: __invis\.text \}, \/\/ MARVEEN-PATCH\(invis1024\)/)
    expect(text).toMatch(/user_id: String\(from\.id\),\n +\.\.\.__invis\.meta, \/\/ MARVEEN-PATCH\(invis1024\)/)
    expect(syntaxErrors(text)).toEqual([])
  })

  type Inbound = { content: string; meta: Record<string, string> }

  // Runs the PATCHED handleInbound of the fixture with a fake mcp and gate: what the channel notification
  // really gets, and what the evidence line wrote on the way there. Only the names the block uses are
  // handed in; the reply/permission branches are never taken.
  function inboundHandler(patched: string, stateDir: string) {
    const start = patched.indexOf('async function handleInbound')
    expect(start).toBeGreaterThan(0)
    const end = patched.indexOf('// --- Server instructions')
    const js = ts.transpileModule(patched.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const notifications: Inbound[] = []
    const mcp = { notification: async (n: { params: Inbound }) => { notifications.push(n.params) } }
    const bot = { api: { sendChatAction: async () => ({}), setMessageReaction: async () => ({}) } }
    const gate = () => ({ action: 'ok', access: {} })
    const handleInbound = new Function('gate', 'PERMISSION_REPLY_RE', 'mcp', 'bot', 'writeFileSync', 'statSync', 'renameSync', 'join', 'STATE_DIR',
      js + '\nreturn handleInbound')(gate, /PERMISSION_REPLY_RE never matches this/, mcp, bot, writeFileSync, statSync, renameSync, join, stateDir)
    return {
      notifications,
      send: async (text: string, forwarded = false) => {
        const ctx = {
          from: { id: 7, username: 'colleague' },
          chat: { id: 42 },
          message: { message_id: 901, date: 0, ...(forwarded ? { forward_origin: { date: 0 } } : {}) },
        }
        await handleInbound(ctx, text, undefined, undefined)
        return notifications[notifications.length - 1]
      },
      evidence: () => readFileSync(join(stateDir, 'inbound-evidence.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l)),
    }
  }

  it('tag characters, zero-width spaces, a BOM and a bidi control: stripped and counted per class; the evidence record holds the RAW text', async () => {
    run()
    // A then three smuggled tag characters, B, two zero-width spaces, C, a BOM, D, one RTL override, E
    const raw = 'A\u{E0041}\u{E0042}\u{E0043}B\u{200B}\u{200B}C\u{FEFF}D\u{202E}E'
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-invis-'))
    try {
      const h = inboundHandler(readFileSync(server, 'utf-8'), stateDir)
      const n = await h.send(raw)
      expect(n.content).toBe('ABCDE')
      expect(n.meta).toEqual({
        chat_id: '42',
        message_id: '901',
        user: 'colleague',
        user_id: '7',
        ts: '1970-01-01T00:00:00.000Z',
        invisible_tag: '3',
        invisible_zwsp: '2',
        invisible_bom: '1',
        invisible_bidi: '1',
      })
      expect(h.evidence().map(r => [r.chat_id, r.message_id, r.text])).toEqual([['42', '901', raw]])
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  // The same edge cases the Teams plugin pins for its stripInvisible (tests/invisibleChars.test.ts there): one rule,
  // two implementations, both held to the same inputs.
  it('the shared rule on its edges: word joiner and isolates, and every malformed flag sequence', async () => {
    run()
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-invis-'))
    const tags = (n: Inbound) => Object.fromEntries(Object.entries(n.meta).filter(([k]) => k.startsWith('invisible_')))
    try {
      const h = inboundHandler(readFileSync(server, 'utf-8'), stateDir)
      const cases: Array<[string, string, Record<string, string>]> = [
        // U+2060..U+2064 are the zwsp class, U+2066..U+2069 the bidi isolates
        ['a\u{2060}b\u{2061}c\u{2064}d', 'abcd', { invisible_zwsp: '3' }],
        ['a\u{2066}b\u{2069}c', 'abc', { invisible_bidi: '2' }],
        // a flag-shaped run without the closing CANCEL TAG: its tags go, the black flag stays
        ['\u{1F3F4}\u{E0067}\u{E0062}', '\u{1F3F4}', { invisible_tag: '2' }],
        // eight tag letters are one too many for a flag: all of them and the cancel tag go
        ['\u{1F3F4}' + '\u{E0061}'.repeat(8) + '\u{E007F}', '\u{1F3F4}', { invisible_tag: '9' }],
        // no tag letter before the cancel tag: not a sequence
        ['x\u{1F3F4}\u{E007F}y', 'x\u{1F3F4}y', { invisible_tag: '1' }],
        // a tag outside the letter/digit range breaks the sequence
        ['\u{1F3F4}\u{E0067}\u{E007B}\u{E007F}', '\u{1F3F4}', { invisible_tag: '3' }],
        // tag digits are part of a valid flag too
        ['\u{1F3F4}\u{E0075}\u{E0073}\u{E0030}\u{E0031}\u{E007F}', '\u{1F3F4}\u{E0075}\u{E0073}\u{E0030}\u{E0031}\u{E007F}', {}],
        // the longest valid flag (seven tag characters) is kept whole
        ['\u{1F3F4}' + '\u{E0061}'.repeat(7) + '\u{E007F}', '\u{1F3F4}' + '\u{E0061}'.repeat(7) + '\u{E007F}', {}],
      ]
      for (const [raw, content, counts] of cases) {
        const n = await h.send(raw)
        expect(n.content).toBe(content)
        expect(tags(n)).toEqual(counts)
      }
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('an emoji tag sequence (the flag of England) and a ZWJ family emoji pass byte-identical', async () => {
    run()
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}'
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-invis-'))
    try {
      const h = inboundHandler(readFileSync(server, 'utf-8'), stateDir)
      for (const whole of [england, family, `${england} ${family}`]) {
        const n = await h.send(whole)
        expect(Buffer.from(n.content, 'utf-8')).toEqual(Buffer.from(whole, 'utf-8'))
        expect(Object.keys(n.meta).filter(k => k.startsWith('invisible_'))).toEqual([])
      }
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('clean text: the content is the same string, no invisible_* key, forwarded and user_id still in the meta', async () => {
    run()
    const stateDir = mkdtempSync(join(tmpdir(), 'tg-invis-'))
    try {
      const h = inboundHandler(readFileSync(server, 'utf-8'), stateDir)
      const n = await h.send('Szia, minden rendben?', true)
      expect(n.content).toBe('Szia, minden rendben?')
      expect(Object.keys(n.meta).filter(k => k.startsWith('invisible_'))).toEqual([])
      expect(n.meta.forwarded).toBe('1')
      expect(n.meta.user_id).toBe('7')
    } finally { rmSync(stateDir, { recursive: true, force: true }) }
  })

  it('a changed content anchor: invis left out with one loud line, the other patches still applied, the 2nd run a no-op', () => {
    const changed = readFileSync(FIXTURE, 'utf-8').replace('content: text,', 'content: String(text),')
    writeFileSync(server, changed)
    const state = join(cache, 'state.json')
    const r = run(['--state', state])
    expect(r.status).toBe(0)
    expect(r.stderr).toMatch(/LOUD: channel content not found exactly once.*the invis patch left out, inbound text reaches the model with its invisible characters/)
    const text = readFileSync(server, 'utf-8')
    expect(text).not.toContain(INVIS)
    expect(text).toContain('MARVEEN-PATCH(elsokor922-d4)')
    expect(text).toContain('MARVEEN-PATCH(elsokor922-fwd)')
    expect(text).toContain('MARVEEN-PATCH(cmd920-evid)')
    expect(text).toContain('MARVEEN-PATCH(c67f5f34-kbd)')
    expect(syntaxErrors(text)).toEqual([])
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', invis: 'anchor-missing:channel content' })
    const once = readFileSync(server, 'utf-8')
    expect(run(['--state', state]).status).toBe(0)
    expect(readFileSync(server, 'utf-8')).toBe(once)
  })

  it('the --state JSON names the invis patch like the others', () => {
    const state = join(cache, 'state.json')
    run(['--state', state])
    expect(readState(state).files[0].patches).toEqual({ d4: 'patched', fwd: 'patched', evid: 'patched', kbd: 'patched', invis: 'patched' })
  })

  it('system-status measures the invis patch on its own, with this marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-invis-status-'))
    try {
      const d = join(dir, 'cache', 'claude-plugins-official', 'telegram', '0.0.7')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'server.ts'), ['elsokor922-d4', 'elsokor922-fwd', 'cmd920-evid', 'c67f5f34-kbd'].map(m => `// MARVEEN-PATCH(${m}): x`).join('\n'))
      const state = join(dir, 'state.json')
      writeFileSync(state, JSON.stringify({ at: 0, root: join(dir, 'cache'), files: [
        { version: '0.0.7', status: 'patched', patches: { d4: 'already', fwd: 'already', evid: 'already', kbd: 'already', invis: 'anchor-missing:channel content' } },
      ] }))
      expect(telegramPluginPatchStatus(state)).toBe('HIÁNYZIK (láthatatlan karakterek): 0.0.7 (anchor-missing:channel content) · a bejövő szövegben maradnak a láthatatlan karakterek, a modell látja őket')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// channels.sh carries the channel wiring and is not part of every checkout this
// test runs in; without it there is nothing to pin here.
const CHANNELS_SH = join(ROOT, 'scripts', 'channels.sh')
const sh = existsSync(CHANNELS_SH) ? readFileSync(CHANNELS_SH, 'utf-8') : ''
describe.skipIf(sh === '')('channels.sh wiring (review #1529, point 1)', () => {
  const code = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')

  it('calls the patcher for Telegram, with the state file, before the session (and so the plugin) is spawned', () => {
    const call = code.indexOf('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"')
    const spawn = code.indexOf('$TMUX new-session -d -s "$SESSION"')
    expect(call).toBeGreaterThan(0)
    expect(spawn).toBeGreaterThan(call)
    // guarded by the Telegram provider check, directly: no other block in between
    const cond = code.lastIndexOf('if [ "$CHANNEL_PROVIDER" = "telegram" ]; then', call)
    expect(cond).toBeGreaterThan(0)
    expect(code.slice(cond, call).split('\n').length).toBeLessThanOrEqual(3)
    // both branches (own config dir / inherited one) write the state file
    expect(code.split('scripts/patch-telegram-plugin.py" --state "$INSTALL_DIR/store/telegram-plugin-patch.json"').length - 1).toBe(2)
  })

  it('an isolated/explicit config dir is handed to the patcher, so it writes the cache the session launches from', () => {
    expect(code).toMatch(/if \[ -n "\$CFG_ENV" \]; then\n\s*CLAUDE_CONFIG_DIR="\$_cfg_dir" python3 "\$INSTALL_DIR\/scripts\/patch-telegram-plugin\.py"/)
  })
})
