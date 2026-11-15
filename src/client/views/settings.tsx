/**
 * Settings (`D9`, `D13`): every effective setting and where it comes from, read only. Settings change in the profile and a redeploy.
 */
import type { ReactNode } from 'react'
import { useResource } from '../api.ts'
import { Icon, Tag } from '../controls.tsx'
import { Page, useDashboard } from '../context.tsx'

const bySource = (record: Readonly<Record<string, readonly string[]>> | undefined) =>
  Object.entries(record ?? {}).map(([source, ids]) => `${source}: ${ids.join(', ') || '—'}`).join(' · ') || '—'

function Pairs({ rows, from }: { rows: readonly [ReactNode, ReactNode][]; from?: string }) {
  const { t } = useDashboard()
  return <div className="panel kvp">{rows.map(([label, value], index) => <div key={index} className="pair"><div className="k">{label}</div><div>{value}</div></div>)}
    {from ? <div className="pair"><div className="k">{t('settings.from')}</div><div className="from">{from}</div></div> : null}</div>
}

export function SettingsView() {
  const { t, people } = useDashboard()
  const resource = useResource('GET settings', {}, 30_000)
  const settings = resource.data
  const name = (id: string) => people[id] ? `@${people[id]}` : id
  const names = (record: Readonly<Record<string, readonly string[]>> | undefined) => bySource(Object.fromEntries(Object.entries(record ?? {}).map(([source, ids]) =>
    [source, source === 'mattermost' ? [...new Set(ids.map(name))] : ids])))
  return <Page crumbs={<span>{t('nav.settings')}</span>} actions={<Tag tone="mute" icon="lock">{t('readOnly')}</Tag>}>
    <p className="note-plain t2"><Icon name="lock" size={13} />{t('settings.readOnly')}</p>
    {!settings ? <p className="t3">{resource.error ? resource.error.message : t('loading')}</p> : <>
      <h3 className="h-sec">{t('settings.models')}</h3>
      <Pairs from={settings.models.from} rows={[[t('settings.model.default'), <span className="mono">{settings.models.default}{settings.models.effort ? ` (${settings.models.effort})` : ''}</span>],
        [t('settings.model.verdict'), <span className="mono">{settings.models.verdict}</span>]]} />
      <h3 className="h-sec">{t('settings.policy')}</h3>
      <Pairs from={settings.policy.from} rows={[[t('settings.senders'), names(settings.policy.senders)],
        ...Object.entries(settings.policy.approvers).map(([workflow, record]) => [`${t('settings.approvers')} · ${workflow}`, names(record)] as [ReactNode, ReactNode]),
        ...Object.entries(settings.policy.repositoryApprovers ?? {}).map(([repo, record]) => [t('settings.repoApprovers', { repo }), names(record)] as [ReactNode, ReactNode]),
        [t('settings.bots'), names(settings.policy.bots)]]} />
      <h3 className="h-sec">{t('settings.repositories')}</h3>
      <div className="panel tbl"><table><thead><tr>{(['name', 'project', 'branch', 'test', 'setup', 'ci', 'registries', 'toolchains', 'match'] as const).map(column =>
        <th key={column}>{t(`settings.col.${column}`)}</th>)}<th>{t('settings.approvers')}</th></tr></thead>
        <tbody>{settings.repositories.map(repo => <tr key={repo.name}><td className="nowrap"><b>{repo.name}</b>{repo.default ? <> <Tag tone="acc">{t('settings.default')}</Tag></> : null}</td>
          <td className="mono">{repo.project}</td><td className="mono">{repo.targetBranch}</td><td className="mono">{repo.testCommand}</td><td className="mono">{repo.setupCommand ?? '—'}</td>
          <td>{repo.ci}</td><td>{(repo.registries ?? []).join(', ') || '—'}</td><td>{Object.entries(repo.toolchains).map(([tool, version]) => `${tool} ${version}`).join(', ') || '—'}</td>
          <td className="wide">{[...repo.match.jira.map(key => `jira ${key}`), ...repo.match.mattermost.map(channel => `mattermost ${channel}`)].join(', ') || '—'}</td>
          <td className="wide">{repo.approvers?.join(', ') ?? t('settings.global')}</td></tr>)}</tbody></table></div>
      <h3 className="h-sec">{t('settings.workflows')}</h3>
      {settings.workflows.map(workflow => <div key={`${workflow.id}@${workflow.version}`} className="panel wf">
        <div><b>{workflow.title}</b> <span className="mono t3">{workflow.id}@{workflow.version}</span></div>
        <div className="steps">{workflow.stages.map(stage => <span key={stage.id} className="step d">{stage.title}<span className="cnt">{stage.model} · {stage.egress}</span></span>)}</div>
        {workflow.budgets ? <div className="mono t2">{t('budget.line', { turns: workflow.budgets.turns, tokens: workflow.budgets.tokens, backtracks: workflow.budgets.backtracks })}</div> : null}
        <div className="mono t3">{Object.entries(workflow.parameters).map(([key, value]) => `${key}=${value}`).join(' · ') || '—'}</div>
      </div>)}
      <h3 className="h-sec">{t('settings.general')}</h3>
      <Pairs rows={[[t('settings.workers'), <span className="mono">{settings.maxWorkers}</span>], [t('settings.locale'), <span className="mono">{settings.locale}</span>],
        [t('settings.demo'), settings.demo ? t('yes') : t('no')],
        [t('settings.links'), <span className="mono">{[settings.links.jira, settings.links.mattermost, settings.links.gitlab].filter(Boolean).join(' · ') || '—'}</span>]]}
        from={settings.links.from} />
    </>}
  </Page>
}
