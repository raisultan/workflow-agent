/**
 * An agent trace's steps (`D13`): one renderer per kind of step. Known tools read as what they did (a command and its output, a
 * file read, an edit as a diff, a search, the stage report); any other tool shows its name, arguments and result. To show a new tool
 * its own way, add a renderer to `TOOLS`.
 */
import type { ReactNode } from 'react'
import type { TraceStep } from '../../app/agent-trace.ts'
import { Icon, Tag, type IconName, type Tone } from '../controls.tsx'
import { offset, tokens } from '../format.ts'
import { JsonButton } from '../json.tsx'
import type { Key, T } from '../locales.ts'

type ToolStep = Extract<TraceStep, { kind: 'tool' }>
type Args = Record<string, unknown>
interface Shown { readonly icon: IconName; readonly tone: Tone; readonly label: Key; readonly head?: ReactNode; readonly body?: ReactNode }

const str = (value: unknown) => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
const lines = (text: string) => text === '' ? 0 : text.split('\n').length

function Output({ t, step, open = false }: { t: T; step: ToolStep; open?: boolean }) {
  if (step.result === undefined) return null
  return <details className="x" open={open || step.error}><summary>{t('step.output')}{step.truncated ? ` · ${t('step.truncated')}` : ''}</summary><pre className="code">{step.result}</pre></details>
}

/** An edit's old and new text as a diff. */
export function diffLines(edits: readonly { old: string; new: string }[]): { kind: 'del' | 'add' | 'hunk'; text: string }[] {
  return edits.flatMap((edit, index) => [...index > 0 || edits.length > 1 ? [{ kind: 'hunk' as const, text: `@@ ${index + 1}` }] : [],
    ...edit.old ? edit.old.split('\n').map(text => ({ kind: 'del' as const, text: `-${text}` })) : [],
    ...edit.new ? edit.new.split('\n').map(text => ({ kind: 'add' as const, text: `+${text}` })) : []])
}
const editsOf = (args: Args) => Array.isArray(args.edits)
  ? (args.edits as Args[]).map(edit => ({ old: str(edit.old_string ?? edit.oldText), new: str(edit.new_string ?? edit.newText) }))
  : [{ old: str(args.old_string ?? args.oldText), new: str(args.new_string ?? args.newText) }]

const path = (args: Args) => str(args.file_path ?? args.path ?? args.filePath)

const TOOLS: Record<string, (t: T, step: ToolStep, args: Args) => Shown> = {
  bash: (t, step, args) => ({ icon: 'terminal', tone: step.error ? 'bad' : 'mute', label: 'step.ran',
    head: step.result === undefined ? <Tag tone="run">{t('step.pending')}</Tag> : step.error ? <Tag tone="bad">{t('step.error')}</Tag> : null,
    body: <><div className="cmd">$ {str(args.command)}</div><Output t={t} step={step} /></> }),
  read: (_t, _step, args) => ({ icon: 'file', tone: 'mute', label: 'step.read',
    head: <><span className="mono ink">{path(args)}</span>{args.offset || args.limit ? <span className="mono t3">{str(args.offset ?? 1)}{args.limit ? `+${str(args.limit)}` : ''}</span> : null}</> }),
  edit: (t, step, args) => {
    const diff = diffLines(editsOf(args))
    return { icon: 'pen', tone: step.error ? 'bad' : 'run', label: 'step.edited',
      head: <><span className="mono ink">{path(args)}</span><span className="mono add">+{diff.filter(line => line.kind === 'add').length}</span>
        <span className="mono del">−{diff.filter(line => line.kind === 'del').length}</span>{step.error ? <Tag tone="bad">{t('step.error')}</Tag> : null}</>,
      body: <><details className="x"><summary>{t('step.diff')}</summary><div className="diff">{diff.map((line, index) =>
        <div key={index} className={line.kind === 'add' ? 'a' : line.kind === 'del' ? 'd' : 'hh'}>{line.text}</div>)}</div></details>{step.error ? <Output t={t} step={step} /> : null}</> }
  },
  write: (t, step, args) => ({ icon: 'pen', tone: 'run', label: 'step.wrote', head: <><span className="mono ink">{path(args)}</span><span className="mono add">+{lines(str(args.content))}</span></>,
    body: step.error ? <Output t={t} step={step} /> : undefined }),
  grep: (t, step, args) => ({ icon: 'search', tone: 'mute', label: 'step.searched', head: <span className="mono ink">«{str(args.pattern)}»{args.path ? ` · ${str(args.path)}` : ''}</span>,
    body: <Output t={t} step={step} /> }),
  glob: (t, step, args) => ({ icon: 'search', tone: 'mute', label: 'step.listed', head: <span className="mono ink">{str(args.pattern)}</span>, body: <Output t={t} step={step} /> }),
  workbench_stage_report: (_t, _step, args) => {
    const items = Array.isArray(args.items) ? (args.items as Args[]).map((item, index) => `${index + 1}. ${str(item.text)}`).join('\n') : ''
    const text = str(args.summary ?? args.reason) || items
    return { icon: 'flag', tone: 'ok', label: 'step.report', head: <Tag tone={args.outcome === 'completed' ? 'ok' : 'wait'}>{str(args.outcome)}</Tag>,
      body: text ? <div className="think">{text}{items && args.summary ? `\n${items}` : ''}</div> : undefined }
  },
}
TOOLS.pwsh = TOOLS.bash!
TOOLS.read_image = TOOLS.read!

function generic(t: T, step: ToolStep): Shown {
  const args = step.args === undefined || (typeof step.args === 'object' && step.args !== null && Object.keys(step.args).length === 0) ? '' : JSON.stringify(step.args)
  return { icon: 'plug', tone: step.error ? 'bad' : 'mute', label: 'step.tool', head: <><span className="mono ink">{step.name}</span>{step.error ? <Tag tone="bad">{t('step.error')}</Tag> : null}</>,
    body: <>{args ? <div className="cmd t2">{args.length > 300 ? `${args.slice(0, 300)}…` : args}</div> : null}<Output t={t} step={step} /></> }
}

function shown(t: T, step: TraceStep): Shown {
  switch (step.kind) {
    case 'input': return { icon: 'input', tone: 'mute', label: 'step.input',
      body: <details className="x"><summary>{step.text.split('\n').find(line => line.trim())?.slice(0, 120)}</summary><pre className="code">{step.text}</pre></details> }
    case 'text': return { icon: 'bulb', tone: 'acc', label: 'step.text', body: <div className="think">{step.text}</div> }
    case 'reasoning': return { icon: 'bulb', tone: 'mute', label: 'step.reasoning', body: <div className="think t3">{step.text}</div> }
    case 'end': return { icon: 'stop', tone: 'mute', label: 'step.end', head: <span className="t3">{step.reason}</span> }
    case 'tool': {
      const args = (typeof step.args === 'object' && step.args !== null ? step.args : {}) as Args
      return TOOLS[step.name]?.(t, step, args) ?? generic(t, step)
    }
  }
}

export function Step({ t, step, startedAt, attemptId }: { t: T; step: TraceStep; startedAt: number; attemptId: string }) {
  const view = shown(t, step)
  const usage = 'usage' in step && step.usage ? step.usage.input + step.usage.output : 0
  return <div className="tr">
    <span className="off mono">{offset(step.at - startedAt)}</span>
    <span className={`si k-${view.tone}`}><Icon name={view.icon} size={12} /></span>
    <div className="sb"><div className="sh"><span className="nm">{t(view.label)}</span>{view.head}
      {'durationMs' in step && step.durationMs !== undefined && step.durationMs >= 1000 ? <span className="mono t3">{(step.durationMs / 1000).toFixed(1)} s</span> : null}
      {usage ? <span className="mono t3">{t('step.tokens', { n: tokens(usage) })}</span> : null}</div>
      {view.body}</div>
    <span><JsonButton title={`${step.kind}${step.kind === 'tool' ? ` ${step.name}` : ''} · ${attemptId} · #${step.seq}`} value={step} /></span>
  </div>
}
