/**
 * What the workbench says in a thread (`T9.2`): the domain's structured messages (`Outbound`) rendered as text, in the
 * deployment's language (Russian or English). Every reply instruction names the words that work, so people can answer in their
 * own words or with a short "ok".
 */
import type { ArtifactRevision, BlockReason, Notice, Outbound } from '../domain/job.ts'
import type { Actor } from '../domain/policy.ts'
import { RISK_CATEGORIES, type MergeRisk, type RiskCategory } from './merge-risk.ts'

export type Locale = 'ru' | 'en'

/** What rendering needs about the job a message belongs to. */
export interface RenderContext {
  readonly locale: Locale
  /** A stage's title in the job's pinned workflow. */
  stageTitle(stageId: string): string
  /** The text of an artifact revision, if it is in the blob store. */
  artifactText(digest: string): string | undefined
  /** The source the message goes to; reply instructions differ in a ticket (`D12`). */
  readonly source?: 'mattermost' | 'jira' | 'gitlab'
  /** A Jira issue's address, when the deployment's Jira is known. */
  ticketUrl?(issueKey: string): string | undefined
  /** Who a question round is addressed to (`D12`): the ticket's author, or the requester, as a mention. */
  readonly addressee?: string
  /** How to name a person: a mention where the source supports one. */
  name(actor: Actor): string
  /** The longest message the thread's source takes. */
  readonly maxChars: number
  /** The `output` a stage attempt reported; the approval post shows a plan's `tests` field from it (`T10.1`). */
  reportOutput?(attemptId: string): Readonly<Record<string, unknown>> | undefined
  /** What the job delivered, for its completion post (`T10.6`): its merge request's link and the commit it pushed last. */
  delivered?(): { mergeRequest?: string | undefined; commit?: string | undefined }
  /** Who may approve the job's plan, each named as `name` names a person in this source (`D12`); empty when nobody is known. */
  approvers?(): readonly string[]
}

/**
 * How every post is laid out, the same in Mattermost, Jira and GitLab: an emoji that says what kind of post it is and a
 * short headline, then the details (each fact on its own line or list item, people's and a model's words quoted), then, after a
 * blank line, a `👉` line that says what to answer. Blocks are separated by blank lines, so a list never swallows the line after it.
 * A proposal keeps its own number (`p2` is 2) as a bold label on a bullet: an ordered list would renumber it from 1.
 */
/** The transition target that ends a job (`$complete`): an approval leading there completes the job rather than move to a stage. */
const END = '$complete'

const TEXT = {
  ru: {
    started: (stage: string) => `🚀 Взял в работу — этап «${stage}».`,
    chatIn: (repository: string) => `💬 Вопросы — в Mattermost, в канале репозитория «${repository}».`,
    chat: (ticket: string | undefined, requester: string) => `🧵 ${ticket ? `Задача ${ticket}` : 'Новая задача'} от ${requester}.\n💬 Вопросы по ней — в этой ветке.`,
    noChatChannel: (repository: string) => `⚠️ У репозитория «${repository}» нет канала в Mattermost для вопросов.\n\n👉 Начните задачу в канале репозитория.`,
    noTicket: (bot: string, projects: readonly string[]) => `⚠️ Не начал работу: нужна задача Jira — в ней живут план и его одобрение.${projects.length > 0
      ? `\nПодходят задачи ${projects.length > 1 ? 'проектов' : 'проекта'} ${projects.join(', ')}.` : ''}\n\n👉 Назовите задачу, например «@${bot} сделай ${projects[0] ?? 'ABC'}-123», или упомяните меня в самой задаче.`,
    question: (round: number) => round > 1 ? `ещё вопросы (раунд ${round}):` : 'нужны ответы:',
    choices: (choices: string) => ` (варианты: ${choices})`,
    answerHow: '👉 Отвечайте в этой ветке, можно частями: «1: …, 2: …».',
    approval: (subject: ArtifactRevision) => `📋 **${kindName('ru', subject.kind)}, ревизия ${subject.n}${subject.title ? ` — ${subject.title}` : ''}** — нужно ваше решение.`,
    approveHow: '👉 Ответьте в этой ветке: «ок» — одобрить, или напишите, что изменить.',
    accepted: (items: string) => `✅ Принял ответы: ${items}.`,
    awaited: (items: string) => `⏳ Жду ответов: ${items}.`,
    allAnswered: '✅ Все ответы есть — продолжаю.',
    redirect: (to: string, item: number, question: string) => `↪️ Передал вопрос ${item} → @${to}: ${question}`,
    answerFailed: '⚠️ Не смог ответить сейчас — спросите ещё раз чуть позже.',
    unread: '🤔 Не понял, к каким вопросам ответ.\n\n👉 Укажите номера: «1: …, 2: …».',
    approveInTicket: '👉 Ответьте комментарием: «ок» — одобрить; вопрос — уточнить; иначе — что изменить.',
    planPosted: (n: number, ticket: string) => `📋 **План, ревизия ${n}** — в задаче ${ticket}.\n\n👉 Обсуждение и одобрение — там.`,
    tests: (tests: string) => `🧪 **Тесты:** ${tests}`,
    exemption: (rule: string, file: string | undefined, reason: string) => `⚠️ **Исключение из проверки тестов** — ${rule}${file ? ` (\`${file}\`)` : ''}: ${reason}`,
    rules: { 'deleted-test': 'удалённый тест', 'removed-test': 'убранные тест-кейсы', 'skip-marker': 'пропуск тестов', 'weakened-assertion': 'ослабленные проверки',
      'test-config': 'изменённые настройки тестов', 'untested-change': 'изменения кода без тестов' },
    approved: (subject: ArtifactRevision | undefined, by: string, next: string) => subject
      ? `✅ **${kindName('ru', subject.kind)}, ревизия ${subject.n}, одобрен(а)** — ${by}.\n${next === END ? '🏁 На этом задача завершена.' : `▶️ Перехожу к этапу «${next}».`}`
      : `▶️ ${by} разрешил(а) продолжить — продолжаю этап «${next}».`,
    notes: '📝 **Учту замечания:**',
    restate: (reading: string) => `${reading ? `🤔 Не уверен, что понял ответ: ${reading}.` : '🤔 Не удалось разобрать ответ.'}\n\n👉 Ответьте ещё раз: «ок» — одобрить, или напишите, что изменить.`,
    reminder: '⏰ Напоминаю: жду вашего ответа выше в этой ветке.',
    blocked: (reason: string) => `⏸ **Работа остановлена:** ${reason}.`,
    extendHow: (amount: string) => `👉 Ответьте «ок», чтобы продлить (${amount}), или «стоп», чтобы отменить задачу.`,
    resumeHow: '👉 Ответьте «повтори», чтобы продолжить, или «стоп», чтобы отменить задачу.',
    rerunHow: '👉 Когда причина устранена, ответьте «ок», чтобы перезапустить проверки на том же коммите, или «стоп», чтобы отменить задачу.',
    completed: (outcome: string | undefined) => `🏁 **Задача завершена**${outcome ? ` — ${outcome}` : ''}.`,
    outcomes: { mr_merged: 'MR влит', mr_closed: 'MR закрыт без слияния' } as Record<string, string>,
    readyForReview: (reworked: boolean) => reworked ? '✅ **Доработал по комментариям в MR — нужен ваш ревью.**' : '✅ **Реализация готова — нужен ваш ревью.**',
    reviewHow: '💬 Комментарии в MR вернут задачу в работу.',
    delivered: { mergeRequest: 'MR', commit: 'Коммит', checks: 'Проверки пройдены' },
    checkNames: { tests: 'тесты', ci: 'CI', integrity: 'целостность тестов', review: 'ревью' } as Record<string, string>,
    notApprover: (to: string, approvers: string) => approvers
      ? `ℹ️ ${to}, одобрить план может только ${approvers}. Вопросы — пожалуйста.` : `ℹ️ ${to}, ваш ответ не одобряет план: одобрить его вы не можете. Вопросы — пожалуйста.`,
    onlyApprovers: (to: string, approvers: string) => `ℹ️ ${to}, менять план может только ${approvers || 'тот, кто его одобряет'}.`,
    closed: (by: string) => `🔒 **Задача закрыта** — ${by}.\nКомментарии её больше не откроют.`,
    closeNotAllowed: (to: string, approvers: string) => `ℹ️ ${to}, закрыть задачу может только ${approvers || 'тот, кто одобряет её план'}.`,
    jobClosed: (why: string | undefined) => `🔒 Задача закрыта${why ? ` — ${why}` : ''}: комментарии её больше не откроют.\n\n👉 Для новой работы начните новую задачу.`,
    proposalOne: (approvers: string, by: string) => `🔁 ${approvers ? `${approvers}, ` : ''}${by} просит изменить требования — учесть в плане?`,
    proposalMany: (approvers: string) => `🔁 ${approvers ? `${approvers}, п` : 'П'}росят изменить требования:`,
    proposalItem: (n: number, text: string, by: string) => `- **${n}.** «${text}» — ${by}`,
    proposalsPending: '🔁 **Ещё ждут решения — изменения требований:**',
    proposalHow: (numbers: readonly number[], onApproval: boolean) => `👉 ${onApproval
      ? 'Ответьте «да» — сделаю новую ревизию с этим; «нет, ок» — отклоню и одобрю текущую ревизию.' : 'Ответьте «да» или «нет».'}${numbers.length > 1 ? ` По пунктам: «${numbers[0]}: да, ${numbers[1]}: нет».` : ''}`,
    news: {
      passed: (approvers: string, ticket: string | undefined) => `➡️ Это меняет требования — передал ${approvers || 'одобряющим'} на решение${ticket ? ` в задаче ${ticket}` : ''}.`,
      accepted: (by: string | undefined, ticket: string | undefined) => `🔁 ${by ? `${by} принял(а) изменение требований: с` : 'Это меняет требования: с'}начала обновлю план${ticket ? ` в задаче ${ticket}` : ''}, потом код.`,
      declined: (by: string) => `✖️ ${by} отклонил(а) это изменение требований.`,
      approved: (revision: number, by: string) => `✅ Включено в план (ревизия ${revision}), одобрено: ${by}.`,
      done: (commit: string | undefined) => `✅ Сделано${commit ? `: коммит \`${commit.slice(0, 12)}\`` : ''}.`,
      dropped: '⚪ Задача закончилась без этого изменения требований.\n\n👉 Если оно нужно, начните новую задачу.',
      expired: '⌛ Решения по этому изменению требований так и не было.\n\n👉 Если оно нужно, напишите о нём снова.',
      unasked: (ticket: string | undefined) => `⚠️ Не смог передать это изменение требований на решение.\n\n👉 Напишите о нём${ticket ? ` в задаче ${ticket}` : ' в задаче'}.`,
    },
    approveElsewhere: (ticket: string | undefined, approvers: string) =>
      `ℹ️ План одобряется ${ticket ? `в задаче ${ticket}` : 'в задаче Jira'}${approvers ? ` — ${approvers}` : ''}.`,
    failed: (reason: string) => `❌ **Задача не выполнена:** ${reason}.`,
    cancelled: (reason: string, by?: string) => `⏹ **Задача отменена**${by ? ` (${by})` : ''}: ${reason}.`,
    truncated: '… (сокращено)',
    reasons: {
      turns: 'закончился бюджет ходов', tokens: 'закончился бюджет токенов', attempts: (stage: string) => `исчерпаны попытки этапа «${stage}»`,
      backtracks: (from: string, to: string) => `исчерпаны возвраты с «${from}» на «${to}»`, blocked: (detail: string) => `этап заблокирован — ${detail}`,
      expired: 'истёк срок ответа на запрос одобрения',
      checks: (checks: string) => `проверки (${checks}) не дали результата по причине окружения, а не кода`,
      setup: 'не удалось подготовить окружение репозитория (инструменты или команда подготовки) — это окружение, а не код',
    },
    setupHow: '👉 Когда причина устранена, ответьте «ок», чтобы повторить подготовку, или «стоп», чтобы отменить задачу.',
    units: { turns: 'ходов', tokens: 'токенов', attempts: 'попыток', backtracks: 'возвратов' },
    noRepository: (requested: string | undefined, names: string) => `${requested === undefined
      ? '🤔 Не понял, в каком репозитории работать.' : `🤔 Не знаю репозиторий «${requested}».`}\n\n👉 Укажите его как \`repo:<имя>\` и упомяните меня снова.\nРепозитории: ${names}.`,
    notAllowed: (repository: string) => `🚫 Вы не можете запускать задачи в репозитории «${repository}».\n\n👉 Попросите того, кому это разрешено.`,
    contradicts: (repository: string, mapped: string) => `ℹ️ Эта ветка относится к репозиторию «${mapped}» — \`repo:${repository}\` здесь не работает.\n\n👉 Начните задачу там, где ведётся работа над «${repository}», или упомяните меня без \`repo:\`.`,
  },
  en: {
    started: (stage: string) => `🚀 On it — starting with the "${stage}" stage.`,
    chatIn: (repository: string) => `💬 Questions about this task go to Mattermost, in the "${repository}" repository's channel.`,
    chat: (ticket: string | undefined, requester: string) => `🧵 ${ticket ? `Task ${ticket}` : 'A new task'}, requested by ${requester}.\n💬 Questions about it are in this thread.`,
    noChatChannel: (repository: string) => `⚠️ The "${repository}" repository has no Mattermost channel for questions.\n\n👉 Start the task in the repository's channel.`,
    noTicket: (bot: string, projects: readonly string[]) => `⚠️ I did not start: this needs a Jira issue, where the plan and its approval live.${projects.length > 0
      ? `\nIssues of ${projects.length > 1 ? 'projects' : 'project'} ${projects.join(', ')} count.` : ''}\n\n👉 Name the issue, like "@${bot} do ${projects[0] ?? 'ABC'}-123", or mention me in the issue itself.`,
    question: (round: number) => round > 1 ? `a few more questions (round ${round}):` : 'I need answers to:',
    choices: (choices: string) => ` (options: ${choices})`,
    answerHow: '👉 Reply in this thread; you can answer several items at once, like "1: …, 2: …".',
    approval: (subject: ArtifactRevision) => `📋 **${kindName('en', subject.kind)}, revision ${subject.n}${subject.title ? ` — ${subject.title}` : ''}** — your decision is needed.`,
    approveHow: '👉 Reply in this thread: "ok" to approve, or say what to change.',
    accepted: (items: string) => `✅ Got answers to: ${items}.`,
    awaited: (items: string) => `⏳ Still open: ${items}.`,
    allAnswered: '✅ All questions are answered — carrying on.',
    redirect: (to: string, item: number, question: string) => `↪️ Passed question ${item} on → @${to}: ${question}`,
    answerFailed: '⚠️ I could not answer just now — ask again a little later.',
    unread: '🤔 I could not tell which questions this answers.\n\n👉 Reply with their numbers: "1: …, 2: …".',
    approveInTicket: '👉 Reply with a comment on the ticket: "ok" to approve, a question to ask about it, or what to change.',
    planPosted: (n: number, ticket: string) => `📋 **Plan revision ${n}** is in ticket ${ticket}.\n\n👉 It is discussed and approved there.`,
    tests: (tests: string) => `🧪 **Tests:** ${tests}`,
    exemption: (rule: string, file: string | undefined, reason: string) => `⚠️ **Exemption from the test check** — ${rule}${file ? ` (\`${file}\`)` : ''}: ${reason}`,
    rules: { 'deleted-test': 'a deleted test', 'removed-test': 'removed test cases', 'skip-marker': 'skipped tests', 'weakened-assertion': 'weakened assertions',
      'test-config': 'changed test configuration', 'untested-change': 'a code change without tests' },
    approved: (subject: ArtifactRevision | undefined, by: string, next: string) => subject
      ? `✅ **${kindName('en', subject.kind)} revision ${subject.n} approved** by ${by}.\n${next === END ? '🏁 That completes the job.' : `▶️ Moving on to "${next}".`}`
      : `▶️ ${by} said to continue — resuming "${next}".`,
    notes: '📝 **I will take these notes into account:**',
    restate: (reading: string) => `${reading ? `🤔 I'm not sure I understood: ${reading}.` : '🤔 I could not read that reply.'}\n\n👉 Please reply again: "ok" to approve, or what to change.`,
    reminder: '⏰ A reminder: I am waiting for your reply above in this thread.',
    blocked: (reason: string) => `⏸ **Work is paused:** ${reason}.`,
    extendHow: (amount: string) => `👉 Reply "ok" to extend it (${amount}), or "stop" to cancel the job.`,
    resumeHow: '👉 Reply "retry" to continue, or "stop" to cancel the job.',
    rerunHow: '👉 Once the cause is fixed, reply "ok" to run the checks again on the same commit, or "stop" to cancel the job.',
    completed: (outcome: string | undefined) => `🏁 **The job is done**${outcome ? ` — ${outcome}` : ''}.`,
    outcomes: { mr_merged: 'the merge request was merged', mr_closed: 'the merge request was closed without merging' } as Record<string, string>,
    readyForReview: (reworked: boolean) => reworked ? '✅ **Reworked after the merge request comments — ready for your review.**' : '✅ **The implementation is ready for your review.**',
    reviewHow: '💬 Comments on the merge request reopen the job.',
    delivered: { mergeRequest: 'Merge request', commit: 'Commit', checks: 'Checks passed' },
    checkNames: { tests: 'tests', ci: 'CI', integrity: 'test integrity', review: 'review' } as Record<string, string>,
    notApprover: (to: string, approvers: string) => approvers
      ? `ℹ️ ${to}, only ${approvers} can approve the plan. Questions are welcome.` : `ℹ️ ${to}, your reply does not approve the plan: you may not approve it. Questions are welcome.`,
    onlyApprovers: (to: string, approvers: string) => `ℹ️ ${to}, only ${approvers || 'the plan\'s approvers'} can change the plan.`,
    closed: (by: string) => `🔒 **Task closed** — ${by}.\nComments no longer reopen it.`,
    closeNotAllowed: (to: string, approvers: string) => `ℹ️ ${to}, only ${approvers || 'the plan\'s approvers'} can close the task.`,
    jobClosed: (why: string | undefined) => `🔒 This task is closed${why ? ` — ${why}` : ''}: comments no longer reopen it.\n\n👉 For new work, start a new task.`,
    proposalOne: (approvers: string, by: string) => `🔁 ${approvers ? `${approvers}, ` : ''}${by} asks to change the requirements — take it into the plan?`,
    proposalMany: (approvers: string) => `🔁 ${approvers ? `${approvers}, c` : 'C'}hanges to the requirements are asked for:`,
    proposalItem: (n: number, text: string, by: string) => `- **${n}.** "${text}" — ${by}`,
    proposalsPending: '🔁 **Still to decide — changes to the requirements:**',
    proposalHow: (numbers: readonly number[], onApproval: boolean) => `👉 ${onApproval
      ? 'Reply "yes" to get a new revision with it, or "no, ok" to decline it and approve this revision.' : 'Reply "yes" or "no".'}${numbers.length > 1 ? ` Or by number: "${numbers[0]}: yes, ${numbers[1]}: no".` : ''}`,
    news: {
      passed: (approvers: string, ticket: string | undefined) => `➡️ This changes the requirements — I passed it to ${approvers || 'the approvers'} to decide${ticket ? ` in ticket ${ticket}` : ''}.`,
      accepted: (by: string | undefined, ticket: string | undefined) => `🔁 ${by ? `${by} accepted the change to the requirements: ` : 'This changes the requirements: '}I will update the plan${ticket ? ` in ticket ${ticket}` : ''} first, then the code.`,
      declined: (by: string) => `✖️ ${by} declined this change to the requirements.`,
      approved: (revision: number, by: string) => `✅ In the plan (revision ${revision}), approved by ${by}.`,
      done: (commit: string | undefined) => `✅ Done${commit ? `: commit \`${commit.slice(0, 12)}\`` : ''}.`,
      dropped: '⚪ The job ended without this change to the requirements.\n\n👉 Start a new job if it is still needed.',
      expired: '⌛ No decision was made on this change to the requirements.\n\n👉 Write about it again if it is still needed.',
      unasked: (ticket: string | undefined) => `⚠️ I could not pass this change to the requirements on for a decision.\n\n👉 Write about it${ticket ? ` in ticket ${ticket}` : ' in the ticket'}.`,
    },
    approveElsewhere: (ticket: string | undefined, approvers: string) =>
      `ℹ️ The plan is approved ${ticket ? `in ticket ${ticket}` : 'in its Jira ticket'}${approvers ? ` — by ${approvers}` : ''}.`,
    failed: (reason: string) => `❌ **The job failed:** ${reason}.`,
    cancelled: (reason: string, by?: string) => `⏹ **The job was cancelled**${by ? ` by ${by}` : ''}: ${reason}.`,
    truncated: '… (truncated)',
    reasons: {
      turns: 'the job ran out of turns', tokens: 'the job ran out of tokens', attempts: (stage: string) => `stage "${stage}" ran out of attempts`,
      backtracks: (from: string, to: string) => `no backtracks left from "${from}" to "${to}"`, blocked: (detail: string) => `the stage is blocked — ${detail}`,
      expired: 'the approval request expired',
      checks: (checks: string) => `the checks (${checks}) could not reach a result, for a reason in the environment, not the code`,
      setup: 'the repository\'s environment could not be prepared (its toolchains or its setup command), a reason in the environment, not the code',
    },
    setupHow: '👉 Once the cause is fixed, reply "ok" to run the setup again, or "stop" to cancel the job.',
    units: { turns: 'turns', tokens: 'tokens', attempts: 'attempts', backtracks: 'backtracks' },
    noRepository: (requested: string | undefined, names: string) => `${requested === undefined
      ? '🤔 I could not tell which repository to work in.' : `🤔 I don't know a repository named "${requested}".`}\n\n👉 Name it as \`repo:<name>\` and mention me again.\nRepositories: ${names}.`,
    notAllowed: (repository: string) => `🚫 You may not start jobs on "${repository}".\n\n👉 Ask someone who may.`,
    contradicts: (repository: string, mapped: string) => `ℹ️ This thread belongs to "${mapped}", so \`repo:${repository}\` does not apply here.\n\n👉 Start the job where "${repository}" is worked on, or mention me without \`repo:\`.`,
  },
} as const

const KINDS: Record<Locale, Record<string, string>> = { ru: { plan: 'План' }, en: { plan: 'Plan' } }

/** How the merge-risk summary reads (`P16`): its level, the categories and their verdicts, the sensitive areas. */
const RISK: Record<Locale, { title: string; level: Record<string, string>; category: Record<RiskCategory, string>; verdict: Record<RiskCategory, Record<string, string>>
  area: Record<string, string>; touched: string; commit: string; unverified: string; footer: string }> = {
  ru: {
    title: 'Риск слияния', level: { low: 'низкий', medium: 'средний', high: 'высокий' },
    category: { alignment: 'Соответствие плану', impact: 'Влияние', verification: 'Проверка', rollback: 'Откат', errors: 'Обнаружение ошибок' },
    verdict: {
      alignment: { good: 'хорошее', decent: 'достаточное', poor: 'слабое' }, impact: { small: 'малое', medium: 'среднее', large: 'большое' },
      verification: { good: 'хорошая', decent: 'достаточная', poor: 'слабая' }, rollback: { low: 'дешёвый', medium: 'средний', high: 'дорогой' },
      errors: { good: 'хорошее', decent: 'достаточное', poor: 'слабое', 'n/a': 'не применимо' },
    },
    area: { migration: 'миграции', auth: 'доступ', secrets: 'секреты', dependencies: 'зависимости', ci: 'CI', infra: 'инфраструктура', impact: 'большое влияние', rollback: 'дорогой откат' },
    touched: 'затронуто', commit: 'коммит', unverified: '⚠️ **Замечания ревью без подтверждения в diff:**',
    footer: 'ℹ️ Оценка модели по плану и diff; на слияние не влияет.\n💬 Комментарии в MR вернут задачу в работу.',
  },
  en: {
    title: 'Merge risk', level: { low: 'low', medium: 'medium', high: 'high' },
    category: { alignment: 'Alignment', impact: 'Impact', verification: 'Verification', rollback: 'Rollback', errors: 'Error detection' },
    verdict: {
      alignment: { good: 'good', decent: 'decent', poor: 'poor' }, impact: { small: 'small', medium: 'medium', large: 'large' },
      verification: { good: 'good', decent: 'decent', poor: 'poor' }, rollback: { low: 'cheap', medium: 'medium', high: 'costly' },
      errors: { good: 'good', decent: 'decent', poor: 'poor', 'n/a': 'n/a' },
    },
    area: { migration: 'migrations', auth: 'access', secrets: 'secrets', dependencies: 'dependencies', ci: 'CI', infra: 'infrastructure', impact: 'large impact', rollback: 'costly rollback' },
    touched: 'touches', commit: 'commit', unverified: '⚠️ **Review claims the diff did not back:**',
    footer: 'ℹ️ A model\'s estimate from the plan and the diff; it does not decide merging.\n💬 Comments on the merge request reopen the job.',
  },
}
const WORST: Record<string, number> = { good: 1, small: 1, low: 1, 'n/a': 0, decent: 2, medium: 2, poor: 3, large: 3, high: 3 }
/** A colour for a level or a verdict, by how bad it is: green, yellow, red; grey for "not applicable". */
const SIGNAL = ['⚪', '🟢', '🟡', '🔴'] as const
const signal = (verdict: string) => SIGNAL[WORST[verdict] ?? 0]

/** The level, and what floored it: «🟡 **Риск слияния: средний** (затронуто: миграции)». */
function riskHead(locale: Locale, risk: MergeRisk): string {
  const text = RISK[locale]
  const floor = risk.floor.map(area => text.area[area] ?? area)
  return `${signal(risk.level)} **${text.title}: ${text.level[risk.level] ?? risk.level}**${floor.length ? ` (${text.touched}: ${floor.join(', ')})` : ''}`
}

/**
 * The merge risk in the completion post: the level as a list item, and under it the first gap of each of the two worst categories,
 * quoted inert (the model wrote them). The whole summary is on the merge request.
 */
function riskItems(locale: Locale, risk: MergeRisk): string[] {
  const text = RISK[locale]
  const gaps = [...RISK_CATEGORIES].sort((a, b) => (WORST[risk.categories[b].verdict] ?? 0) - (WORST[risk.categories[a].verdict] ?? 0))
    .flatMap(name => risk.categories[name].gaps.slice(0, 1).map(gap => `  - **${text.category[name]}:** ${inert(gap, 200)}`)).slice(0, 2)
  return [`- ${riskHead(locale, risk)}`, ...gaps]
}

/**
 * A review note's unverified claim (`- (unverified important: <why>) <where>: <issue>`, as `reviewNotes` writes it) as a list item
 * in the post's language: the claim, then its severity and why the host did not find its evidence. The issue stays as the model wrote it.
 */
function unverifiedLine(line: string, locale: Locale): string {
  const match = /^- \(unverified (critical|important): (.*?)\) (.*)$/u.exec(line)
  if (!match) return line
  const [, severity, why, claim] = match as unknown as [string, 'critical' | 'important', string, string]
  return `- ${claim} (${UNVERIFIED[locale].severity[severity]}: ${whyUnverified(why, locale)})`
}
const UNVERIFIED: Record<Locale, { severity: Record<'critical' | 'important', string>; why: readonly (readonly [RegExp, (part: string) => string])[] }> = {
  ru: {
    severity: { critical: 'критичное', important: 'важное' },
    why: [
      [/^its quote names no file$/u, () => 'цитата не называет файл'],
      [/^its quote is unchanged code, away from the change$/u, () => 'цитата — неизменённый код вдали от изменения'],
      [/^its quote is not in the diff of (.+)$/u, file => `цитаты нет в diff файла ${file}`],
      [/^(.+) is not in the diff$/u, file => `файла ${file} нет в diff`],
      [/^its plan quote is not in the plan or a follow-up$/u, () => 'цитаты нет ни в плане, ни в дополнениях к нему'],
      [/^it names no token the change lacks$/u, () => 'не названо, чего не хватает в изменении'],
      [/^"(.+)" is not what its plan quote or issue names$/u, token => `«${token}» не из цитаты плана и не из замечания`],
      [/^"(.+)" is in the change$/u, token => `«${token}» есть в изменении`],
      [/^it gives no evidence$/u, () => 'нет доказательств'],
    ],
  },
  en: { severity: { critical: 'critical', important: 'important' }, why: [] },
}
/** Why a claim is unverified, in the post's language when the reason is one the host writes; else as it is. */
function whyUnverified(why: string, locale: Locale): string {
  for (const [pattern, say] of UNVERIFIED[locale].why) {
    const match = pattern.exec(why)
    if (match) return say(match[1] ?? '')
  }
  return why
}

/** A merge request's link, named by its project and number (`orders-api!2`) when its address says them. */
function mergeRequestLink(url: string): string {
  const match = /\/([^/]+)\/-\/merge_requests\/(\d+)/u.exec(url)
  return match ? `[${match[1]}!${match[2]}](${url})` : url
}
function kindName(locale: Locale, kind: string): string {
  return KINDS[locale][kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1)
}

function reasonText(context: RenderContext, reason: BlockReason): string {
  const text = TEXT[context.locale].reasons
  switch (reason.kind) {
    case 'budget': return reason.budget === 'turns' ? text.turns : text.tokens
    case 'attempts': return text.attempts(context.stageTitle(reason.stageId))
    case 'backtracks': return text.backtracks(context.stageTitle(reason.from), context.stageTitle(reason.to))
    case 'stage_blocked': return text.blocked(inert(reason.detail, 500))
    case 'gate_expired': return text.expired
    case 'checks_blocked': return text.checks(reason.checks.join(', '))
    case 'setup_blocked': return text.setup
  }
}

/** The longest check evidence a blocked post quotes. */
const DETAIL_MAX = 1500

/**
 * Text the workbench quotes but did not write (a check's evidence, a model's review, an agent's reason), made inert for a chat post:
 * mentions (`@name`, Jira's `[~name]`) and links (`scheme://`, `www.`) are broken with a zero-width space so they
 * notify no one and link nowhere, and the text is cut to `max` characters.
 */
export function inert(text: string, max: number): string {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text
  return cut.replace(/@(?=[\w.-])/gu, '@\u200b').replace(/\[~/gu, '[\u200b~').replace(/\b([a-z][a-z0-9+.-]*):\/\//giu, '$1:\u200b//')
    .replace(/\bwww\./giu, 'www\u200b.')
}

/**
 * A plan's `tests` field for the approval post. Its exemption lines (`exempt <rule> <path>: <reason>`, as `planExemptions` reads
 * them) are machine text: each is shown as a sentence that names the rule in words, so the approver sees what they exempt.
 */
function testsLines(tests: string, locale: Locale): string[] {
  const text = TEXT[locale]
  const plain: string[] = [], exemptions: string[] = []
  for (const line of tests.trim().split('\n')) {
    const match = /^\s*(?:exempt|исключение)\s+([a-z-]+)(?:\s+([^\s:]+))?\s*:\s*(\S.*)$/iu.exec(line)
    const rule = match && (text.rules as Record<string, string>)[match[1]!.toLowerCase()]
    if (match && rule) exemptions.push(text.exemption(rule, match[2]?.replace(/^[[`]+|[\]`]+$/gu, '') || undefined, match[3]!.trim()))
    else plain.push(line)
  }
  const stated = plain.join('\n').trim()
  return [...stated ? [text.tests(stated)] : [], ...exemptions]
}

/** A proposal's number, the one people use to answer by item: the digits of its id (`p2` is 2), the same in every post. */
export const proposalNumber = (id: string) => Number(/\d+$/u.exec(id)?.[0] ?? 0)

/** Renders a message for its thread, cut to the source's limit. */
export function render(message: Outbound, context: RenderContext): string {
  const text = TEXT[context.locale]
  const lines: string[] = []
  // A ticket is named with its link where the deployment's Jira is known.
  const ticket = (key: string) => { const url = context.ticketUrl?.(key); return url ? `[${key}](${url})` : key }
  const ticketOr = (key: string | undefined) => key === undefined ? undefined : ticket(key)
  switch (message.kind) {
    case 'started':
      lines.push(text.started(context.stageTitle(message.stageId)))
      if (message.chatIn) lines.push(text.chatIn(message.chatIn))
      break
    case 'chat': lines.push(text.chat(ticketOr(message.ticket), context.name(message.requester))); break
    case 'question':
      {
        const ask = text.question(message.round)
        lines.push(`❓ ${context.addressee ? `${context.addressee}, ${ask}` : ask.charAt(0).toUpperCase() + ask.slice(1)}`, '')
      }
      message.items.forEach((item, index) => lines.push(`${index + 1}. ${item.text}${item.choices?.length ? text.choices(item.choices.join(' / ')) : ''}`))
      lines.push('', text.answerHow)
      break
    case 'approval': {
      // The artifact between rules, so the reader sees where the workbench's frame ends and the plan begins.
      const body = context.artifactText(message.subject.digest)
      lines.push(text.approval(message.subject))
      if (body) lines.push('', '---', '', body.trim(), '', '---')
      const tests = context.reportOutput?.(message.subject.attemptId)?.tests
      if (typeof tests === 'string' && tests.trim()) lines.push('', ...testsLines(tests, context.locale))
      // Proposals still before the approvers are decided here too (`D12`), so they are listed with how to decide them.
      if (message.proposals?.length) {
        lines.push('', text.proposalsPending, '', ...message.proposals.map(proposal => text.proposalItem(proposalNumber(proposal.id), inert(proposal.text.trim(), 500), context.name(proposal.by))),
          '', text.proposalHow(message.proposals.map(proposal => proposalNumber(proposal.id)), true))
      } else lines.push('', context.source === 'jira' ? text.approveInTicket : text.approveHow)
      break
    }
    // What this reply changed (the items it answered, whom a question was passed to), then what is still awaited.
    case 'answersRecorded':
      if (message.remaining.length === 0) { lines.push(text.allAnswered); break }
      if (message.answered.length > 0) lines.push(text.accepted(message.answered.join(', ')))
      for (const redirect of message.redirects) lines.push(text.redirect(redirect.to, redirect.item, redirect.text))
      lines.push(text.awaited(message.remaining.join(', ')))
      break
    case 'unread': lines.push(text.unread); break
    // A model wrote the answer from the job's context, which people wrote: it is posted inert, so it mentions and links no one.
    case 'answer': lines.push(inert(message.text.trim(), 3000)); break
    case 'answerFailed': lines.push(text.answerFailed); break
    case 'planPosted': lines.push(text.planPosted(message.subject.n, ticket(message.ticket))); break
    case 'approved':
      lines.push(text.approved(message.subject, context.name(message.by), context.stageTitle(message.next)))
      if (message.notes) lines.push('', `${text.notes} ${message.notes}`)
      break
    // The model's reading is a sentence; the template adds its own full stop.
    case 'restate': lines.push(text.restate(message.reading.trim().replace(/[.!?…\s]+$/u, ''))); break
    case 'reminder': lines.push(text.reminder); break
    case 'blocked': {
      lines.push(text.blocked(reasonText(context, message.reason)))
      // The check's or the setup's evidence is machine output: quoted, so it reads as what the tool said.
      if (message.reason.kind === 'checks_blocked' || message.reason.kind === 'setup_blocked') lines.push('', quoted(inert(message.reason.detail.trim(), DETAIL_MAX)))
      const amounts = Object.entries(message.extension ?? {}).map(([unit, amount]) => `+${amount} ${text.units[unit as keyof typeof text.units] ?? unit}`)
      lines.push('', amounts.length > 0 ? text.extendHow(amounts.join(', ')) : message.reason.kind === 'checks_blocked' ? text.rerunHow
        : message.reason.kind === 'setup_blocked' ? text.setupHow : text.resumeHow)
      break
    }
    case 'completed': {
      // A job that hands over a merge request is ready for people to review, not done (`D12`): it says so, and how to get it back.
      const { mergeRequest, commit } = context.delivered?.() ?? {}
      const handedOver = message.outcome === 'completed' && mergeRequest !== undefined
      lines.push(handedOver ? text.readyForReview(message.reworked === true)
        : text.completed(message.outcome === 'completed' ? undefined : text.outcomes[message.outcome] ?? message.outcome))
      const facts = [
        ...mergeRequest ? [`- **${text.delivered.mergeRequest}:** ${mergeRequestLink(mergeRequest)}`] : [],
        ...commit ? [`- **${text.delivered.commit}:** \`${commit.slice(0, 12)}\``] : [],
        ...message.checks?.length ? [`- **${text.delivered.checks}:** ${message.checks.map(id => text.checkNames[id] ?? id).join(', ')}`] : [],
        ...handedOver && message.risk ? riskItems(context.locale, message.risk as unknown as MergeRisk) : [],
      ]
      if (facts.length) lines.push('', ...facts)
      if (handedOver) lines.push('', text.reviewHow)
      break
    }
    case 'mergeRisk': {
      // The whole summary, on the merge request: what the model wrote is quoted inert, so it mentions and links no one.
      const risk = message.risk as unknown as MergeRisk
      const words = RISK[context.locale]
      lines.push(`${riskHead(context.locale, risk)}${risk.commit ? ` · ${words.commit} \`${risk.commit.slice(0, 8)}\`` : ''}`, '')
      for (const name of RISK_CATEGORIES) {
        const category = risk.categories[name]
        lines.push(`- ${signal(category.verdict)} **${words.category[name]}:** ${words.verdict[name][category.verdict] ?? category.verdict}`,
          ...category.gaps.map(gap => `  - ${inert(gap, 200)}`))
      }
      const unverified = (message.notes ?? '').split('\n').filter(line => /^- \(unverified (critical|important)/u.test(line))
      if (unverified.length) lines.push('', words.unverified, '', ...unverified.map(line => inert(unverifiedLine(line, context.locale), 400)))
      lines.push('', words.footer)
      break
    }
    case 'notApprover': lines.push(text.notApprover(context.name(message.to), (context.approvers?.() ?? []).join(', '))); break
    case 'closed': lines.push(text.closed(context.name(message.by))); break
    case 'closeNotAllowed': lines.push(text.closeNotAllowed(context.name(message.to), (context.approvers?.() ?? []).join(', '))); break
    case 'jobClosed':
      lines.push(text.jobClosed(message.fact ? text.outcomes[message.fact] ?? message.fact : message.by ? context.name(message.by) : undefined))
      break
    case 'proposalAsk': {
      // A proposal is people's words, quoted inert so it mentions and links no one (`D12`).
      const approvers = (context.approvers?.() ?? []).join(', ')
      if (message.to) lines.push(text.onlyApprovers(context.name(message.to), approvers), '')
      const [first] = message.proposals
      if (message.proposals.length === 1 && first) lines.push(text.proposalOne(approvers, context.name(first.by)), '', quoted(inert(first.text.trim(), 1000)))
      else lines.push(text.proposalMany(approvers), '', ...message.proposals.map(proposal => text.proposalItem(proposalNumber(proposal.id), inert(proposal.text.trim(), 500), context.name(proposal.by))))
      lines.push('', text.proposalHow(message.proposals.map(proposal => proposalNumber(proposal.id)), message.onApproval === true))
      break
    }
    case 'proposalNews': {
      const approvers = (context.approvers?.() ?? []).join(', ')
      const by = message.by ? context.name(message.by) : undefined
      const where = ticketOr(message.ticket)
      switch (message.news) {
        case 'passed': lines.push(text.news.passed(approvers, where)); break
        case 'accepted': lines.push(text.news.accepted(by, where)); break
        case 'declined': lines.push(text.news.declined(by ?? approvers)); break
        case 'approved': lines.push(text.news.approved(message.revision ?? 0, by ?? approvers)); break
        case 'done': lines.push(text.news.done(context.delivered?.().commit)); break
        case 'dropped': lines.push(text.news.dropped); break
        case 'expired': lines.push(text.news.expired); break
        case 'unasked': lines.push(text.news.unasked(where)); break
      }
      break
    }
    case 'approveElsewhere':
      lines.push(text.approveElsewhere(ticketOr(message.ticket), (context.approvers?.() ?? []).join(', ')))
      break
    case 'failed': lines.push(text.failed(inert(message.reason, 500))); break
    case 'cancelled': lines.push(text.cancelled(message.reason, message.by && context.name(message.by))); break
  }
  const out = lines.join('\n')
  return cut(context.source === 'gitlab' ? hardBreaks(out) : out, context.maxChars, text.truncated)
}

/** Text quoted as a block: each line behind `> `. */
function quoted(text: string): string {
  return text.split('\n').map(line => `> ${line}`.trimEnd()).join('\n')
}

/**
 * GitLab renders a single newline as a space (CommonMark), so a post's lines would run together there. Each line
 * followed by another that does not start a block of its own (a list item, a heading, a table, a rule, a fence) ends in a hard break
 * (two spaces); code is left as it is.
 */
export function hardBreaks(text: string): string {
  const lines = text.split('\n')
  const FENCE = /^\s*(```|~~~)/u
  const BLOCK = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|\||(```|~~~)|([-*_])(\s*\3){2,}\s*$)/u
  let code = false
  return lines.map((line, index) => {
    if (FENCE.test(line)) { code = !code; return line }
    const next = lines[index + 1]
    if (code || next === undefined || !line.trim() || !next.trim() || BLOCK.test(next) || /^\s*(#{1,6}\s|\|)/u.test(line) || / {2}$|\\$/u.test(line)) return line
    return `${line}  `
  }).join('\n')
}

/**
 * Renders a notice about a trigger that started no job (`T11.1`). The requested name is the sender's text, so it is quoted inert.
 * `bot` is the workbench's Mattermost username, for the example of how to name a ticket.
 */
export function renderNotice(notice: Notice, locale: Locale, maxChars: number, bot = 'workbench'): string {
  const text = TEXT[locale]
  switch (notice.kind) {
    case 'no_repository':
      return cut(text.noRepository(notice.requested === undefined ? undefined : inert(notice.requested, 60), notice.names.join(', ') || '—'), maxChars, text.truncated)
    case 'repository_refused':
      return cut(notice.reason === 'contradicts' ? text.contradicts(notice.repository, notice.mapped) : text.notAllowed(notice.repository), maxChars, text.truncated)
    case 'no_chat_channel':
      return cut(text.noChatChannel(notice.repository), maxChars, text.truncated)
    case 'no_ticket':
      return cut(text.noTicket(bot, notice.projects ?? []), maxChars, text.truncated)
  }
}

/** Cuts `text` to `max` characters, keeping its end instruction when the middle (an artifact) is what is long. */
function cut(text: string, max: number, marker: string): string {
  if (text.length <= max) return text
  const tail = text.slice(text.lastIndexOf('\n\n'))
  const head = text.slice(0, Math.max(0, max - tail.length - marker.length - 1))
  return `${head}\n${marker}${tail}`.slice(0, max)
}
