/**
 * An attempt's agent trace (`D13`, `T15.3`): a DSH session log (synthetic, in the shapes DSH 0.2.2 stores) turned into steps: the
 * workbench's input, the agent's text and reasoning, tool calls with their results and timing, usage, and the turn's end.
 */
import { expect, it } from 'vitest'
import { normalizeTrace, readTrace, TRACE_STEPS_MAX, type SessionReader } from '../src/app/agent-trace.ts'

const at = (seconds: number) => 1_794_582_273_000 + seconds * 1000
const LOG = [
  { type: 'session/title', seq: 7, time: at(0), data: { title: 'x' } },
  { type: 'user/message', seq: 13, time: at(1), data: { role: 'user', content: [{ type: 'text', text: '# Request\n@workbench сделай' }], source: { kind: 'workflow-agent', form: 'relay' } } },
  { type: 'user/message', seq: 14, time: at(1), data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context' } } },
  { type: 'system/message', seq: 12, time: at(1), data: { message: { role: 'system', content: [{ type: 'text', text: 'You are an AI agent' }] } } },
  { type: 'assistant/message', seq: 18, time: at(3), data: { turn: 1, step: 1, usage: { inputTokens: 524, outputTokens: 84, cacheReadTokens: 3456 }, message: { role: 'assistant', content: [
    { type: 'reasoning', text: 'The ticket does not say where the currency comes from.' },
    { type: 'text', text: 'Сначала прочитаю задачу.' },
    { type: 'tool-call', id: 'call_1', name: 'jira_get_issue', arguments: '{"issue_key":"ORD-307"}' },
    { type: 'tool-call', id: 'call_2', name: 'bash', arguments: '{"command":"python -m pytest -q"}' }] } } },
  { type: 'tool/call', seq: 19, time: at(3), data: { callId: 'call_1', name: 'jira_get_issue', arguments: '{"issue_key":"ORD-307"}' } },
  { type: 'tool/result', seq: 20, time: at(4), data: { message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '{"key":"ORD-307"}' }], isError: false } } },
  { type: 'tool/call', seq: 21, time: at(4), data: { callId: 'call_2', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', seq: 22, time: at(14), data: { message: { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'F'.repeat(40) }], isError: true } } },
  { type: 'some/future-event', seq: 23, time: at(15), data: {} },
  { type: 'turn/end', seq: 24, time: at(16), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
]

it('turns a session log into the input, text, reasoning, tool calls with results, usage and the end', () => {
  const trace = normalizeTrace('wb-job_1-a1', LOG, 32)
  expect(trace.sessionId).toBe('wb-job_1-a1')
  expect(trace.steps.map(step => step.kind)).toEqual(['input', 'reasoning', 'text', 'tool', 'tool', 'end'])
  expect(trace.steps[0]).toMatchObject({ kind: 'input', text: '# Request\n@workbench сделай' })
  // Usage is the step's, carried by its first block.
  expect(trace.steps[1]).toMatchObject({ kind: 'reasoning', usage: { input: 524, output: 84, cached: 3456 } })
  expect(trace.steps[2]).not.toHaveProperty('usage')
  expect(trace.steps[3]).toMatchObject({ kind: 'tool', name: 'jira_get_issue', args: { issue_key: 'ORD-307' }, result: '{"key":"ORD-307"}', durationMs: 1000 })
  expect(trace.steps[3]).not.toHaveProperty('error')
  expect(trace.steps[4]).toMatchObject({ kind: 'tool', name: 'bash', error: true, durationMs: 10_000, truncated: true, result: `${'F'.repeat(32)}…` })
  expect(trace.steps[5]).toMatchObject({ kind: 'end', reason: 'aborted: user' })
})

it('cuts long arguments too: a write carries a whole file', () => {
  const trace = normalizeTrace('wb-w', [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [
    { type: 'tool-call', id: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'big.txt', content: 'x'.repeat(100) }) }] } } }], 10)
  expect(trace.steps[0]).toMatchObject({ kind: 'tool', args: { file_path: 'big.txt', content: `${'x'.repeat(10)}…` }, truncated: true })
})

it('keeps the last 500 steps of a long attempt and says how many earlier ones it left out', () => {
  const turn = (n: number) => [
    { type: 'assistant/message', seq: n * 2, time: at(n), data: { message: { content: [{ type: 'tool-call', id: `c${n}`, name: 'bash', arguments: `{"command":"echo ${n}"}` }] } } },
    { type: 'tool/result', seq: n * 2 + 1, time: at(n + 1), data: { message: { toolCallId: `c${n}`, content: [{ type: 'text', text: `out ${n}` }] } } }]
  const long = normalizeTrace('wb-long', Array.from({ length: 620 }, (_, n) => turn(n)).flat())
  expect(TRACE_STEPS_MAX).toBe(500)
  expect(long.steps.length).toBe(500)
  expect(long.omitted).toBe(120)
  // The newest are kept, each call still with its own result.
  expect(long.steps[0]).toMatchObject({ kind: 'tool', callId: 'c120', result: 'out 120' })
  expect(long.steps.at(-1)).toMatchObject({ kind: 'tool', callId: 'c619', result: 'out 619' })
  const short = normalizeTrace('wb-short', Array.from({ length: 500 }, (_, n) => turn(n)).flat())
  expect(short.steps.length).toBe(500)
  expect(short).not.toHaveProperty('omitted')
  expect(normalizeTrace('wb-cap', turn(1).concat(turn(2), turn(3)), 100, 2)).toMatchObject({ omitted: 1, steps: [{ callId: 'c2' }, { callId: 'c3' }] })
})

it('reads a tool result and an input whose content is a plain string', () => {
  const trace = normalizeTrace('wb-s', [
    { type: 'user/message', seq: 1, time: 1, data: { content: 'do it', source: { kind: 'workflow-agent' } } },
    { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'tool-call', id: 's1', name: 'bash', arguments: '{}' }] } } },
    { type: 'tool/result', seq: 3, time: 3, data: { message: { toolCallId: 's1', content: 'plain output' } } }])
  expect(trace.steps).toEqual([expect.objectContaining({ kind: 'input', text: 'do it' }), expect.objectContaining({ kind: 'tool', result: 'plain output' })])
})

it('shows a running attempt as far as it got: a call without its result yet', () => {
  const trace = normalizeTrace('wb-x', LOG.slice(0, 8))
  const last = trace.steps.at(-1)!
  expect(last).toMatchObject({ kind: 'tool', name: 'bash' })
  expect(last).not.toHaveProperty('result')
})

it('reads through a read handle, closes it, and reports a missing or unreadable session instead of failing', async () => {
  let closed = 0
  const found: SessionReader = { open: async () => ({ read: async () => ({ events: LOG }), close: async () => { closed++ } }) }
  expect((await readTrace(found, 'wb-a')).steps).toHaveLength(6)
  expect(closed).toBe(1)
  const missing: SessionReader = { open: async () => { throw Object.assign(new Error('no durable log'), { name: 'SessionPersistenceNotFoundError' }) } }
  expect(await readTrace(missing, 'wb-b')).toEqual({ sessionId: 'wb-b', steps: [], unavailable: { reason: 'missing', detail: 'no durable log' } })
  const unsupported: SessionReader = { open: async () => { throw Object.assign(new Error('format version 9 is newer than this build'), { name: 'SessionFormatUnsupportedError' }) } }
  expect((await readTrace(unsupported, 'wb-c')).unavailable).toMatchObject({ reason: 'unreadable' })
  const broken: SessionReader = { open: async () => ({ read: async () => { throw new Error('torn') }, close: async () => { closed++ } }) }
  expect((await readTrace(broken, 'wb-d')).unavailable).toEqual({ reason: 'unreadable', detail: 'torn' })
  expect(closed).toBe(2)
})
