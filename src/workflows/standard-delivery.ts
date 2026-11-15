/**
 * `standard-delivery` (`T9.7`): inspect → plan (approved by a person, with what will be tested and any exemption from the
 * test-integrity rules) → implement (the tests, CI, the test-integrity check and a clean-context review must pass) → completed with
 * a merge request open; review feedback on that merge request reopens the job at `review`, and merging or closing it closes the job
 * (`completeOn`). Everything workplace-specific is a parameter frozen in each job's manifest: the chosen repository's
 * (`{{repository}}`, `{{targetBranch}}`, `{{testCommand}}`, and `ci`, which leaves the CI check out for a repository with none) and
 * the deployment's Jira status names, so the definition is the same in every deployment. Stage instructions are English, each with
 * a Russian variant (`.ru`, `D14`). Each conversation has its place (`D12`): questions and a blocked job's resume in the job's chat
 * thread, the plan's approval in its Jira ticket, code on its merge request.
 *
 * Implement and review audit their own diff before they commit (it serves the plan, the tests reach the boundaries the plan names,
 * the other users of a changed shared name still work) and write the merge request's description in a fixed shape; the stages
 * follow the target repository's own conventions when it states them, and what they write to people is laid out as the host's own
 * posts are (`STYLE`). The prompts are text: the host checks none of what they ask.
 */
import type { WorkflowSpec } from '../domain/definition.ts'

const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: true })
const strings = { type: 'array', items: { type: 'string' } }

/** The parameters a deployment sets for this workflow. */
export const STANDARD_DELIVERY_PARAMETERS = ['repository', 'targetBranch', 'testCommand', 'ci', 'jira.inProgress', 'jira.inReview'] as const

/**
 * How everything the agents write to people reads (`D12`), in Russian: short and structured, and laid out as the host's own posts
 * are (`messages.ts`): a headline with an emoji, the facts on lines of their own, blank lines between blocks (GitLab joins
 * lines a single newline separates), and a `👉` line when the reader has to do something.
 */
const STYLE_RU = 'Как писать людям (вопросы, комментарии в Jira, ответы в MR): по-русски, коротко и по делу — сначала то, что нужно от читателя; '
  + 'нумерованные пункты; без вступлений, без пересказа задачи, без любезностей. Вопрос — одна строка; варианты ответа — в `choices`, не в тексте вопроса.\n'
  + 'Оформление комментария в Jira и ответа в MR (не вопросов в `questions` — их оформляет хост): первая строка — эмодзи и короткий заголовок жирным (`✅ **Исправлено**`, `📋 **Требования подтверждены**`, `🔗 **MR на ревью**`); '
  + 'дальше — факты, каждый отдельной строкой или пунктом списка; между блоками (заголовок, список, вывод) — пустая строка: без неё GitLab склеит строки в один абзац. '
  + 'Ссылки — `[текст](url)`; файлы, команды, коммиты и идентификаторы из кода — в `обратных кавычках`. Если от читателя что-то нужно — последняя строка, '
  + 'после пустой: `👉 …`. Эмодзи — только в начале строки, не больше одного на строку.'

/** How people and what they wrote are named in everything a stage writes: by name, never by a role or an internal id. */
const PEOPLE_RU = 'Как называть людей и их слова: человека — по имени, как во входных данных (`@dev-ivan`), а не по роли («заказчик», «одобряющий», «автор») '
  + 'и не по внутреннему идентификатору. На идентификаторы комментариев Jira (`c-…`) и другие внутренние идентификаторы не ссылайся: назови автора и процитируй или перескажи комментарий.'

/** How a round's answers are read (the marks are `ANSWER_MARKS` of the stage runner): the latest answer to an item counts. */
const ANSWERS_RU = 'Ответы на вопросы во входных данных: на каждый вопрос действует последний ответ. Ответ с пометкой «(заменён ответом ниже)» не учитывай: '
  + 'автор сам его исправил. Если на вопрос ответили разные люди и ответы расходятся — следуй последнему и прямо назови расхождение: чей ответ принят и чей с ним расходится.'

/** Where a requirement comes from, at the end of its line: the same form in the scope comment and in the plan. */
const SOURCES_RU = 'каждая строка заканчивается источником: `— @имя` (кто дал ответ), `— из задачи` (описание задачи; для комментария в задаче — `— из задачи, @автор`) '
  + 'или `— допущение` (никто не ответил, или ответ был «не знаю, решай сам»). Строка без источника — ошибка'

const REPORT_RU = [
  'Как завершать этап: вызови `workbench_stage_report`.',
  '- `outcome: "completed"` — этап готов: `summary` и `output` по схеме этапа (и `artifact`, если этап его производит).',
  '- `outcome: "question"` — нужны ответы человека: перечисли ВСЕ открытые вопросы сразу в `questions` (хост сам опубликует их и вернёт ответы).',
  '- `outcome: "backtrack"` — нужно вернуться на более ранний этап: `backtrackTo` и `reason`.',
  '- `outcome: "blocked"` — дальше без помощи человека нельзя (нет доступа и т. п.): `reason`.',
  'Хост проверит отчёт; если он отклонён, ошибка инструмента скажет почему — исправь и отправь снова.',
].join('\n')

/** What every implement and review shell has (`D11`), so a plan does not count on CI for tests that need a database or a broker. */
const SERVICES_RU = 'Тестовые сервисы: в каждой команде shell на этапах `implement` и `review` (и в проверке хоста) доступны Postgres (`localhost:5432`, '
  + '`DATABASE_URL`, пользователь и пароль `postgres`), RabbitMQ (`localhost:5672`, `AMQP_URL`, `guest`/`guest`) и Kafka (`localhost:9092`, '
  + '`KAFKA_BOOTSTRAP_SERVERS`); имена `postgres`, `rabbitmq`, `kafka` тоже работают. Каждый сервис стартует при первом подключении и '
  + 'чистый в каждой команде: данные между командами не сохраняются, поэтому миграции и подготовка данных — в той же команде, что и тесты.'

/** The target repository's own rules come before the agent's habits (`T16.7`); the reviewer's check does not read them. */
const CONVENTIONS_RU = 'Соглашения репозитория: если в корне рабочей копии есть `AGENTS.md` или `CONTRIBUTING.md`, сначала прочитай их и следуй им '
  + '(структура, стиль, тесты, сообщения коммитов); где они расходятся с твоими привычками — правы они.'

/**
 * The self-audit before a commit (`T16.7`). Its three checks each catch a mistake a review tends to miss: a shared constant changed
 * for one route, a test of a default that never reached it, and a planned test that was not written.
 */
const selfAuditRu = (step: number, before: string, note = '') => [
  `${step}. «Самопроверка» — ${before}, все три пункта:${note}`,
  '   (1) Прочитай `git diff {{targetBranch}}...` построчно; то, что ещё не закоммичено, в него не попадает — прочитай так же `git diff HEAD` и новые файлы из `git status`. Каждое изменение служит плану. Остальное убери; если убрать нельзя — перечисли в разделе «Вне плана» описания MR, с причиной.',
  '   (2) Сверь тесты с разделом «План тестирования»: на каждый его пункт есть тест, и данные теста доходят до границы, которую пункт называет. '
    + 'Значение по умолчанию 20 проверяется больше чем на 20 записях; максимум — своим значением (максимум 100 — запросом ровно с этим значением и более чем 100 записями), а не меньшим. Тест, который прошёл бы и без изменения, ничего не проверяет.',
  '   (3) Если изменена общая константа, схема или вспомогательная функция — найди `grep` все места, где она используется, и проверь или покрой тестом каждое: изменение, нужное одному месту, не должно менять поведение остальных.',
  '   Нашёл расхождение — исправь и снова запусти тесты (`{{testCommand}}`).',
]

/** The merge request's description (`T16.7`): the same four headings every time. The host does not check them. */
const MR_DESCRIPTION_RU = [
  '   Описание MR (`description`) — всегда по шаблону, все четыре раздела, в этом порядке:',
  '   ```markdown',
  '   ## Что изменено',
  '   ## Допущения',
  '   ## Вне плана',
  '   ## Как проверено',
  '   ```',
  '   «Что изменено» — по пунктам, по файлам или по требованиям плана. «Допущения» — допущения плана и те, что появились в работе, или «нет». '
    + '«Вне плана» — изменения, которых нет в плане, с причиной, или «нет». «Как проверено» — команды, которые ты запускал, и что они показали (например, `{{testCommand}}` — 42 passed).',
]

const promptsRu = {
  inspect: [
    'Этап `inspect`: разбери запрос, задачу Jira и кодовую базу; уточни неоднозначные требования у человека.',
    'Рабочая копия репозитория — твоя текущая директория (только чтение).',
    '1. Найди ключ задачи Jira в запросе, прочитай задачу (`jira_get_issue`) и её текстовые вложения (`jira_read_attachment_text`), и сделай её задачей этой работы (`jira_link_issue`), если она ещё не связана.',
    '2. При первом входе на этап переведи задачу в статус «{{jira.inProgress}}» (`jira_transition_issue`). Статусы Jira движутся только вперёд.',
    '3. Изучи код (`glob`, `grep`, `read`).',
    '4. Если требования неоднозначны (граничные случаи, ошибки, лимиты, валидация) и ответов на это во входных данных ещё нет — не додумывай: задай все вопросы одним отчётом `outcome: "question"`.',
    '5. Когда требования подтверждены (или однозначны с самого начала): запиши их комментарием в Jira (`jira_add_comment`) и заверши этап с `output: { clarifiedScope, filesInspected }`.',
    `   Комментарий — нумерованный список требований; ${SOURCES_RU}. Расхождение в ответах разных людей назови в строке требования. В \`clarifiedScope\` — тот же список с источниками.`,
    ANSWERS_RU,
    STYLE_RU,
    PEOPLE_RU,
    '',
    REPORT_RU,
  ].join('\n'),
  plan: [
    'Этап `plan`: составь технический план реализации. Человек одобрит его или попросит изменить; хост сам опубликует план и запрос одобрения.',
    'Рабочая копия — текущая директория (только чтение). Учитывай во входных данных: подтверждённые требования и запрошенные изменения. Вопросы к плану хост отвечает сам, в задаче.',
    SERVICES_RU,
    CONVENTIONS_RU,
    `Требования в плане — с источником. Раздел 1 содержит список «Требования»: по строке на требование, ${SOURCES_RU}. Кто что ответил — во входных данных и в комментарии этапа \`inspect\` в задаче.`,
    'Ответ «не знаю, решай сам» — это допущение: прими разумное решение и перечисли все допущения отдельным разделом, чтобы люди, которые одобряют план, их видели.',
    ANSWERS_RU + ' В плане расхождение — строка раздела «Допущения».',
    'План — это решения, а не ход рассуждений. В «Изменения по файлам» — только то, что будет сделано: без «либо… либо», «возможно», «проверить и при необходимости убрать», «итоговое решение». '
      + 'Выбери вариант сам; отвергнутые варианты не описывай. Сомнение, которое ты решил сам, — строка в «Допущения»; сомнение, которое решить нельзя, — вопрос (правило 1). Допущения не противоречат списку изменений.',
    'План описывает целевое состояние кода после работы — относительно ветки `{{targetBranch}}`, а не относительно того, что уже лежит в рабочей копии. Новая ревизия (после отклонённой или изменённой) — снова полный план, '
      + 'а не список отличий от прежней и не правки к ветке: не пиши «убрать строку…», «удалить тест (строки 165–187)» о коде, которого нет в `{{targetBranch}}`. Если в рабочей копии уже есть часть работы, '
      + 'скажи это одной строкой в «Причина и контекст»; шаги относительно ветки — дело этапа `implement`. Модель, которая потом проверяет изменения, сравнивает план со всем diff от `{{targetBranch}}`.',
    'Принятые изменения требований (во входных данных — «Changes requested»: что просили и кто) план включает целиком и перечисляет в разделе 1 списком «Изменения по запросам»: '
      + 'по строке на изменение — что и кто просил. Каждое из них — и строка в «Требования» с этим источником.',
    'План (по-русски):',
    '```markdown',
    '### 📋 Технический план (<КЛЮЧ_ЗАДАЧИ>)',
    '#### 1. Причина и контекст',
    '**Требования**',
    '1. <требование> — <источник>',
    '**Изменения по запросам** (если есть)',
    '1. <изменение> — просил @<имя>',
    '#### 2. Изменения по файлам',
    '#### 3. План тестирования',
    '#### 4. Допущения (если есть)',
    '#### 5. Риски (если есть)',
    '```',
    '1. Если для плана не хватает продуктовых требований — вернись на `inspect` (`outcome: "backtrack"`, `backtrackTo: "inspect"`) с тем, что нужно уточнить.',
    '2. Не публикуй план сам: хост опубликует его в задаче Jira и даст на него ссылку в Mattermost. Заверши этап с `artifact: { text: <полный план>, title: <одна строка> }` и `output: { steps, tests }`.',
    '   `title` — одна строка о сути изменения (например, «Пагинация списка заказов: limit и offset»), без слова «план», ключа задачи и номера ревизии: хост сам пишет «План, ревизия N — <title>». В заголовке и в тексте плана номер ревизии тоже не пиши.',
    '   `tests` — какие тесты будут добавлены или изменены и что они проверят. Только если тесты действительно не нужны (например, правка текста или конфигурации), напиши `none: <почему>`. Человек увидит это поле в запросе одобрения; хост потом проверит, что изменения кода сопровождаются тестами.',
    '   Если план намеренно делает то, что хост считает ослаблением тестов (например, удаляет устаревший тест или меняет настройки тестов), добавь в `tests` отдельной строкой `exempt <правило> <путь>: <почему>` (путь — без скобок и кавычек, например `exempt deleted-test tests/test_legacy.py: API удаляется вместе с тестом`); правила: `deleted-test`, `removed-test`, `skip-marker`, `weakened-assertion`, `test-config`, `untested-change`. Исключение действует, только если человек одобрит план с ним.',
    '   Строка `exempt …` — для хоста, и только в `tests`: человеку хост покажет её словами. В тексте плана то же самое скажи словами в «Плане тестирования» (какой тест удаляется или ослабляется и почему).',
    STYLE_RU,
    PEOPLE_RU,
    '',
    REPORT_RU,
  ].join('\n'),
  implement: [
    'Этап `implement`: реализуй одобренный план (он во входных данных) в рабочей копии — твоей текущей директории.',
    SERVICES_RU,
    CONVENTIONS_RU,
    '1. Если план технически невыполним — вернись на `plan` (`backtrack`); если не хватает требований — на `inspect`.',
    '   План описывает целевое состояние кода относительно `{{targetBranch}}`. Если в рабочей копии уже есть часть работы (прежняя попытка, прежняя ревизия плана), сам приведи её к плану: убери лишнее, добавь недостающее.',
    '2. Реализуй план с тестами. Запусти тесты (`{{testCommand}}`) и добейся зелёного результата. Хост сам запустит тесты и CI ещё раз — этап завершится только если они пройдут.',
    '   Хост также сверит изменения с исходной веткой: удалённые или пропущенные тесты (`.skip`, `.only`, `xfail`), ослабленные проверки, изменённые настройки тестов или покрытия и изменения кода без тестов не дают завершить этап. Если существующий тест мешает — исправь код или вернись на `plan`, а не тест. Затем отдельная модель проверит изменения по одобренному плану.',
    ...selfAuditRu(3, 'до коммита'),
    '4. Создай ветку `agent/<ключ-задачи-в-нижнем-регистре>-<ascii-slug>`, закоммить изменения (`git -c user.name="Workflow Agent" -c user.email="workflow-agent@localhost" commit`), опубликуй её `gitlab_push_branch`.',
    '5. Открой Merge Request в `{{targetBranch}}` (`gitlab_create_mr`) или обнови уже открытый (`gitlab_update_mr`); переведи задачу в статус «{{jira.inReview}}» и оставь в Jira комментарий со ссылкой на MR: первая строка — `🔗 **MR на ревью:** [<проект>!<номер>](<ссылка>)`, ниже — что сделано, пунктами.',
    ...MR_DESCRIPTION_RU,
    '6. Заверши этап с `output: { branch, mrUrl }`.',
    STYLE_RU,
    PEOPLE_RU,
    '',
    REPORT_RU,
  ].join('\n'),
  review: [
    'Этап `review`: по Merge Request пришла обратная связь (она во входных данных). Рабочая копия — текущая директория.',
    SERVICES_RU,
    CONVENTIONS_RU,
    '1. Если замечание меняет требования или архитектуру — вернись на `plan` или `inspect` (`backtrack`) с причиной.',
    '2. Иначе исправь код с тестами и запусти их (`{{testCommand}}`). Тесты нельзя удалять, пропускать или ослаблять: хост это проверит.',
    ...selfAuditRu(3, 'до коммита и публикации ветки', ' План здесь — одобренный план вместе с принятыми замечаниями по MR.'),
    '4. Закоммить в ту же ветку (`git -c user.name="Workflow Agent" -c user.email="workflow-agent@localhost" commit`) и опубликуй её (`gitlab_push_branch`).',
    '5. Приведи описание MR к текущему состоянию ветки (`gitlab_update_mr`, поле `description`): оно описывает весь MR, а не последнюю правку.',
    ...MR_DESCRIPTION_RU,
    '6. Ответь в обсуждении MR (`gitlab_reply_discussion`), что исправлено: первая строка — «✅ **Исправлено** в `<короткий хеш коммита>`», ниже — что изменилось, пунктами; если замечание не принято — «ℹ️ **Не изменено:** <почему>».',
    '7. Заверши этап с `output: { summary }`.',
    STYLE_RU,
    PEOPLE_RU,
    '',
    REPORT_RU,
  ].join('\n'),
}

/** How everything the agents write to people reads, in English (`D14`); the same rules as `STYLE_RU`. */
const STYLE_EN = 'How to write to people (questions, Jira comments, merge request replies): in English, short and to the point — first what the reader needs; '
  + 'numbered items; no preamble, no retelling of the task, no pleasantries. A question is one line; answer options go in `choices`, not in the question text.\n'
  + 'Layout of a Jira comment and a merge request reply (not of questions in `questions`: the host lays those out): the first line is an emoji and a short bold headline (`✅ **Fixed**`, `📋 **Requirements confirmed**`, `🔗 **MR for review**`); '
  + 'then the facts, each on its own line or as a list item; a blank line between blocks (headline, list, conclusion): without it GitLab joins the lines into one paragraph. '
  + 'Links as `[text](url)`; files, commands, commits and identifiers from the code in `backticks`. If the reader has to do something, the last line, '
  + 'after a blank one, is `👉 …`. Emoji only at the start of a line, at most one per line.'

/** How people and what they wrote are named, in English. */
const PEOPLE_EN = 'How to name people and their words: a person by their name as it appears in the inputs (`@dev-ivan`), not by a role ("the customer", "the approver", "the author") '
  + 'and not by an internal id. Do not refer to Jira comment ids (`c-…`) or other internal ids: name the author and quote or summarise the comment.'

/** How a round's answers are read, in English (the marks are the stage runner's English `ANSWER_MARKS_BY_LOCALE`). */
const ANSWERS_EN = 'Answers to questions in the inputs: for each question the latest answer counts. Ignore an answer marked "(replaced by the answer below)": '
  + 'its author corrected it. If different people answered a question and their answers differ, follow the latest one and name the disagreement plainly: whose answer was taken and whose differs from it.'

/** Where a requirement comes from, at the end of its line, in English. */
const SOURCES_EN = 'each line ends with its source: `— @name` (who gave the answer), `— from the ticket` (the ticket description; for a comment in the ticket, `— from the ticket, @author`) '
  + 'or `— assumption` (nobody answered, or the answer was "I don\'t know, you decide"). A line without a source is a mistake'

const REPORT_EN = [
  'How to finish the stage: call `workbench_stage_report`.',
  '- `outcome: "completed"` — the stage is done: `summary` and `output` per the stage\'s schema (and `artifact`, if the stage produces one).',
  '- `outcome: "question"` — you need a person\'s answers: list ALL open questions at once in `questions` (the host posts them and returns the answers).',
  '- `outcome: "backtrack"` — you need to go back to an earlier stage: `backtrackTo` and `reason`.',
  '- `outcome: "blocked"` — you cannot go on without a person\'s help (no access and the like): `reason`.',
  'The host checks the report; if it is rejected, the tool error says why — fix it and send it again.',
].join('\n')

const SERVICES_EN = 'Test services: every shell command in the `implement` and `review` stages (and the host\'s check) can use Postgres (`localhost:5432`, '
  + '`DATABASE_URL`, user and password `postgres`), RabbitMQ (`localhost:5672`, `AMQP_URL`, `guest`/`guest`) and Kafka (`localhost:9092`, '
  + '`KAFKA_BOOTSTRAP_SERVERS`); the names `postgres`, `rabbitmq` and `kafka` work too. Each service starts on its first connection and '
  + 'is fresh in every command: data does not carry over between commands, so migrations and test data go in the same command as the tests.'

const CONVENTIONS_EN = 'Repository conventions: if the root of the working copy has `AGENTS.md` or `CONTRIBUTING.md`, read them first and follow them '
  + '(structure, style, tests, commit messages); where they differ from your habits, they win.'

/** The self-audit before a commit, in English: the same three checks as `selfAuditRu`. */
const selfAuditEn = (step: number, before: string, note = '') => [
  `${step}. "Self-audit" — ${before}, all three points:${note}`,
  '   (1) Read `git diff {{targetBranch}}...` line by line; what is not committed yet is not in it, so read `git diff HEAD` and the new files from `git status` the same way. Every change serves the plan. Remove the rest; if it cannot be removed, list it under "Outside the plan" in the merge request description, with the reason.',
  '   (2) Check the tests against the "Test plan" section: every item of it has a test, and the test\'s data reaches the boundary the item names. '
    + 'A default of 20 is tested with more than 20 records; a maximum with its own value (a maximum of 100 with a request for exactly that value and more than 100 records), not a smaller one. A test that would pass without the change checks nothing.',
  '   (3) If a shared constant, schema or helper changed, find every place that uses it with `grep`, and check or cover each with a test: a change one place needs must not change how the others behave.',
  '   If you find a mismatch, fix it and run the tests again (`{{testCommand}}`).',
]

/** The merge request's description, in English: the same four headings every time. */
const MR_DESCRIPTION_EN = [
  '   The merge request description (`description`) always follows this template, all four sections, in this order:',
  '   ```markdown',
  '   ## What changed',
  '   ## Assumptions',
  '   ## Outside the plan',
  '   ## How it was checked',
  '   ```',
  '   "What changed": by item, by file or by the plan\'s requirements. "Assumptions": the plan\'s assumptions and any that came up during the work, or "none". '
    + '"Outside the plan": changes the plan does not have, with the reason, or "none". "How it was checked": the commands you ran and what they showed (for example, `{{testCommand}}` — 42 passed).',
]

const promptsEn = {
  inspect: [
    'Stage `inspect`: work through the request, the Jira ticket and the codebase; clarify ambiguous requirements with a person.',
    'The repository\'s working copy is your current directory (read-only).',
    '1. Find the Jira issue key in the request, read the issue (`jira_get_issue`) and its text attachments (`jira_read_attachment_text`), and make it this work\'s ticket (`jira_link_issue`) if it is not linked yet.',
    '2. On the first visit to this stage, move the issue to the status "{{jira.inProgress}}" (`jira_transition_issue`). Jira statuses only move forward.',
    '3. Study the code (`glob`, `grep`, `read`).',
    '4. If the requirements are ambiguous (edge cases, errors, limits, validation) and the inputs do not answer it yet, do not guess: ask all the questions in one report with `outcome: "question"`.',
    '5. When the requirements are confirmed (or clear from the start), write them as a Jira comment (`jira_add_comment`) and finish the stage with `output: { clarifiedScope, filesInspected }`.',
    `   The comment is a numbered list of requirements; ${SOURCES_EN}. Name a disagreement between people's answers in the requirement's line. \`clarifiedScope\` holds the same list with its sources.`,
    ANSWERS_EN,
    STYLE_EN,
    PEOPLE_EN,
    '',
    REPORT_EN,
  ].join('\n'),
  plan: [
    'Stage `plan`: write a technical plan for the implementation. A person will approve it or ask for changes; the host posts the plan and the approval request itself.',
    'The working copy is the current directory (read-only). Take into account what the inputs hold: the confirmed requirements and the changes requested. The host answers questions about the plan itself, in the ticket.',
    SERVICES_EN,
    CONVENTIONS_EN,
    `The plan's requirements carry their source. Section 1 holds the list "Requirements": one line per requirement, ${SOURCES_EN}. Who answered what is in the inputs and in the \`inspect\` stage's comment in the ticket.`,
    'An answer "I don\'t know, you decide" is an assumption: make a reasonable decision and list all assumptions in their own section, so the people who approve the plan see them.',
    ANSWERS_EN + ' In the plan, a disagreement is a line in "Assumptions".',
    'A plan is decisions, not a train of thought. "Changes by file" holds only what will be done: no "either… or", "possibly", "check and remove if needed", "final decision". '
      + 'Choose the option yourself; do not describe the rejected ones. A doubt you resolved yourself is a line in "Assumptions"; a doubt you cannot resolve is a question (rule 1). The assumptions do not contradict the list of changes.',
    'The plan describes the target state of the code after the work, relative to the branch `{{targetBranch}}`, not relative to what is already in the working copy. A new revision (after a rejected or changed one) is again a full plan, '
      + 'not a list of differences from the previous one and not edits to the branch: do not write "remove the line…", "delete the test (lines 165–187)" about code that is not in `{{targetBranch}}`. If the working copy already has part of the work, '
      + 'say so in one line in "Reason and context"; steps relative to the branch are the `implement` stage\'s business. The model that later checks the changes compares the plan with the whole diff from `{{targetBranch}}`.',
    'Accepted changes to the requirements (in the inputs: "Changes requested": what was asked and by whom) are included in the plan in full and listed in section 1 as "Requested changes": '
      + 'one line per change, what was asked and by whom. Each of them is also a line in "Requirements" with that source.',
    'The plan (in English):',
    '```markdown',
    '### 📋 Technical plan (<ISSUE_KEY>)',
    '#### 1. Reason and context',
    '**Requirements**',
    '1. <requirement> — <source>',
    '**Requested changes** (if any)',
    '1. <change> — asked by @<name>',
    '#### 2. Changes by file',
    '#### 3. Test plan',
    '#### 4. Assumptions (if any)',
    '#### 5. Risks (if any)',
    '```',
    '1. If the plan lacks product requirements, go back to `inspect` (`outcome: "backtrack"`, `backtrackTo: "inspect"`) with what needs clarifying.',
    '2. Do not post the plan yourself: the host posts it in the Jira ticket and links to it in Mattermost. Finish the stage with `artifact: { text: <the full plan>, title: <one line> }` and `output: { steps, tests }`.',
    '   `title` is one line about the essence of the change (for example, "Order list pagination: limit and offset"), without the word "plan", the issue key or the revision number: the host writes "Plan, revision N — <title>" itself. Do not write the revision number in the heading or the plan text either.',
    '   `tests`: which tests will be added or changed and what they will check. Only if tests are really not needed (for example, a text or configuration change), write `none: <why>`. A person sees this field in the approval request; the host later checks that code changes come with tests.',
    '   If the plan deliberately does something the host counts as weakening the tests (for example, deletes an obsolete test or changes test settings), add a separate line to `tests`: `exempt <rule> <path>: <why>` (the path without brackets or quotes, for example `exempt deleted-test tests/test_legacy.py: the API is removed together with the test`); the rules: `deleted-test`, `removed-test`, `skip-marker`, `weakened-assertion`, `test-config`, `untested-change`. The exemption holds only if a person approves the plan with it.',
    '   The `exempt …` line is for the host, and only in `tests`: the host shows it to people in words. In the plan text, say the same in words in "Test plan" (which test is removed or weakened, and why).',
    STYLE_EN,
    PEOPLE_EN,
    '',
    REPORT_EN,
  ].join('\n'),
  implement: [
    'Stage `implement`: implement the approved plan (it is in the inputs) in the working copy, your current directory.',
    SERVICES_EN,
    CONVENTIONS_EN,
    '1. If the plan is technically infeasible, go back to `plan` (`backtrack`); if requirements are missing, to `inspect`.',
    '   The plan describes the target state of the code relative to `{{targetBranch}}`. If the working copy already has part of the work (an earlier attempt, an earlier revision of the plan), bring it in line with the plan yourself: remove what is extra, add what is missing.',
    '2. Implement the plan with tests. Run the tests (`{{testCommand}}`) and get them green. The host runs the tests and CI again itself; the stage finishes only if they pass.',
    '   The host also compares the changes with the source branch: deleted or skipped tests (`.skip`, `.only`, `xfail`), weakened assertions, changed test or coverage settings, and code changes without tests stop the stage from finishing. If an existing test is in the way, fix the code or go back to `plan`, not the test. Then a separate model reviews the changes against the approved plan.',
    ...selfAuditEn(3, 'before the commit'),
    '4. Create the branch `agent/<issue-key-in-lowercase>-<ascii-slug>`, commit the changes (`git -c user.name="Workflow Agent" -c user.email="workflow-agent@localhost" commit`), and publish it with `gitlab_push_branch`.',
    '5. Open a merge request into `{{targetBranch}}` (`gitlab_create_mr`) or update the one already open (`gitlab_update_mr`); move the issue to the status "{{jira.inReview}}" and leave a Jira comment with the merge request link: the first line is `🔗 **MR for review:** [<project>!<number>](<link>)`, below it what was done, as items.',
    ...MR_DESCRIPTION_EN,
    '6. Finish the stage with `output: { branch, mrUrl }`.',
    STYLE_EN,
    PEOPLE_EN,
    '',
    REPORT_EN,
  ].join('\n'),
  review: [
    'Stage `review`: feedback came in on the merge request (it is in the inputs). The working copy is the current directory.',
    SERVICES_EN,
    CONVENTIONS_EN,
    '1. If a comment changes the requirements or the architecture, go back to `plan` or `inspect` (`backtrack`) with the reason.',
    '2. Otherwise fix the code with tests and run them (`{{testCommand}}`). Tests may not be deleted, skipped or weakened: the host checks this.',
    ...selfAuditEn(3, 'before the commit and pushing the branch', ' The plan here is the approved plan together with the accepted merge request comments.'),
    '4. Commit to the same branch (`git -c user.name="Workflow Agent" -c user.email="workflow-agent@localhost" commit`) and publish it (`gitlab_push_branch`).',
    '5. Bring the merge request description up to date with the branch (`gitlab_update_mr`, the `description` field): it describes the whole merge request, not the last fix.',
    ...MR_DESCRIPTION_EN,
    '6. Reply in the merge request discussion (`gitlab_reply_discussion`) with what was fixed: the first line is "✅ **Fixed** in `<short commit hash>`", below it what changed, as items; if a comment was not taken, "ℹ️ **Not changed:** <why>".',
    '7. Finish the stage with `output: { summary }`.',
    STYLE_EN,
    PEOPLE_EN,
    '',
    REPORT_EN,
  ].join('\n'),
}

/**
 * The prompts: English as the base, and each Russian one as its `.ru` variant (`D14`), chosen by the deployment's `locale` when a
 * job starts and frozen in its manifest.
 */
const prompts: Record<string, string> = {
  ...promptsEn,
  ...Object.fromEntries(Object.entries(promptsRu).map(([name, text]) => [`${name}.ru`, text])),
}

/** The standard delivery workflow, version 13. */
export function standardDelivery(): WorkflowSpec {
  const limits = (turns: number, minutes: number, attempts = 3) => ({ attempts, turns, tokens: 4_000_000, wallClockMs: minutes * 60_000 })
  const checks = [{ id: 'tests', kind: 'command', params: { command: '{{testCommand}}', timeoutMs: 20 * 60_000 } }, { id: 'ci', kind: 'gitlab-ci', when: { parameter: 'ci', equals: 'required' } },
    { id: 'integrity', kind: 'test-integrity' }, { id: 'review', kind: 'review' }]
  return {
    id: 'standard-delivery',
    version: 13,
    prompts,
    declaration: {
      title: 'Standard delivery',
      start: 'inspect',
      triggers: [{ sources: ['mattermost', 'jira'], on: ['mention', 'direct'] }],
      stages: [
        { id: 'inspect', title: 'Requirements analysis', titles: { ru: 'Анализ требований' }, agentPreset: 'workflow-agent-inspector', permissionPreset: 'workflow-agent-readonly', egress: 'none',
          instructions: 'inspect', tools: ['jira.link', 'jira.comment', 'jira.transition'], questionRounds: 3, limits: limits(80, 30),
          output: object({ clarifiedScope: { type: 'string', minLength: 1 }, filesInspected: strings }, ['clarifiedScope']) },
        { id: 'plan', title: 'Implementation plan', titles: { ru: 'План реализации' }, agentPreset: 'workflow-agent-planner', permissionPreset: 'workflow-agent-readonly', egress: 'none',
          instructions: 'plan', tools: [], questionRounds: 0, artifact: 'plan', limits: limits(60, 30),
          output: object({ steps: { ...strings, minItems: 1 }, tests: { type: 'string', minLength: 1 } }, ['steps', 'tests']) },
        { id: 'implement', title: 'Implementation and MR', titles: { ru: 'Реализация и MR' }, agentPreset: 'workflow-agent-implementer', permissionPreset: 'workflow-agent-worker', egress: 'registries',
          instructions: 'implement', tools: ['gitlab.push', 'gitlab.createMr', 'gitlab.updateMr', 'jira.comment', 'jira.transition'], questionRounds: 0,
          checks, limits: limits(200, 90),
          output: object({ branch: { type: 'string', minLength: 1 }, mrUrl: { type: 'string' } }, ['branch']) },
        { id: 'review', title: 'MR review', titles: { ru: 'Ревью MR' }, agentPreset: 'workflow-agent-reviewer', permissionPreset: 'workflow-agent-worker', egress: 'registries',
          instructions: 'review', tools: ['gitlab.push', 'gitlab.updateMr', 'gitlab.reply'], questionRounds: 0, checks, limits: limits(150, 60),
          output: object({ summary: { type: 'string' } }) },
      ],
      transitions: [
        { from: 'inspect', to: 'plan' },
        { from: 'plan', to: 'implement', gate: 'plan-approval' },
        { from: 'implement', to: '$complete' },
        { from: 'review', to: '$complete' },
      ],
      backtracks: [
        { from: 'plan', to: 'inspect', budget: 2 },
        { from: 'implement', to: 'plan', budget: 2 }, { from: 'implement', to: 'inspect', budget: 1 },
        { from: 'review', to: 'plan', budget: 2 }, { from: 'review', to: 'inspect', budget: 1 },
      ],
      gates: [{ id: 'plan-approval', kind: 'approval', reminderMs: 24 * 3_600_000, deadlineMs: 7 * 24 * 3_600_000 }],
      budgets: { turns: 1500, tokens: 40_000_000, backtracks: 4, extension: { turns: 500, tokens: 10_000_000, attempts: 2, backtracks: 2 } },
      reopen: { stage: 'review', requirements: 'plan' },
      // A merge closes the job (`D12`): it takes no more feedback, and its open proposals end. A merge request closed without a
      // merge closes it too.
      completeOn: ['mr_merged', 'mr_closed'],
      repository: true,
      places: { clarification: 'chat', plan: 'ticket', code: 'mergeRequest' },
    },
  }
}
