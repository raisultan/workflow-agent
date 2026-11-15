/**
 * The labelled reply set (`T9.11`, `A12`): synthetic Russian and English replies a person might write to an approval request, each
 * with the verdict it should get. Approvals with notes approve; a condition is a change request; sarcasm, hedging and partial
 * answers are unclear. `pnpm eval:replies` runs the set against the configured verdict model, and the release bar is zero false
 * approvals: no reply outside `approve` and `approve_with_notes` may approve.
 */
export type ReplyLabel = 'approve' | 'approve_with_notes' | 'request_changes' | 'question' | 'cancel' | 'unrelated' | 'unclear'
export interface LabelledReply { readonly text: string; readonly label: ReplyLabel; readonly lang: 'ru' | 'en' | 'mixed' }

const set = (label: ReplyLabel, lang: LabelledReply['lang'], texts: readonly string[]): LabelledReply[] => texts.map(text => ({ text, label, lang }))

export const REPLIES: readonly LabelledReply[] = [
  ...set('approve', 'ru', [
    'ок', 'Окей', 'Согласовано', 'Аппрув', 'Да, делай', 'План одобряю', 'Всё хорошо, приступай к реализации', 'Согласен, вперёд',
    'Принято, можно реализовывать', 'Отличный план, запускай', 'Да', 'Годится', 'Норм, погнали', 'Одобряю этот план полностью',
    'Возражений нет, делай', 'Подтверждаю, можно начинать', 'Всё устраивает, реализуй',
  ]),
  ...set('approve', 'en', [
    'LGTM', 'Approved.', 'Looks good to me, go ahead', '+1', 'Ship it', 'Yes, proceed with the implementation', 'No objections, go ahead',
    'Approve', 'The plan is fine, start implementing', 'Sounds good, go for it', 'Yep, all good', 'Great plan, approved', '👍 go ahead',
  ]),
  ...set('approve', 'mixed', ['Ок, ship it', 'LGTM, делай', 'Approved, погнали']),
  ...set('approve_with_notes', 'ru', [
    'Одобряю. При реализации переиспользуй существующий хелпер для дат.', 'Согласовано, и не забудь обновить README по ходу.',
    'Ок, план принят. На будущее: логи пиши в JSON.', 'Да, делай. Имена переменных держи в стиле проекта.',
    'Одобряю, в описании MR укажи ссылку на задачу.', 'План хороший, запускай. Тесты клади рядом с модулем, как у нас принято.',
    'Принято. Если будет время, добавь метрику на время ответа — но это не блокер.', 'Согласен, реализуй; ревьюером поставь Анну.',
  ]),
  ...set('approve_with_notes', 'en', [
    'Approved. Please reuse the existing date helper while implementing.', 'LGTM, and keep the commit messages in English.',
    'Go ahead; mention the ticket in the MR description.', 'Approved — nice to have: a metric for latency, not a blocker.',
    'Looks good, proceed. Follow the usual naming for the new tests.', 'Ship it, and ping me when the MR is up.',
  ]),
  ...set('request_changes', 'ru', [
    'Ок, но добавь индекс', 'Аппрув, только сначала добавь индекс', 'Согласен, кроме миграции таблицы users', 'Ок, но переделай схему БД',
    'Нет, так не пойдёт — перепиши шаг 3', 'Согласую, если уберёшь изменение конфигурации прода', 'Почти, поменяй порядок шагов 2 и 4',
    'Добавь тесты на граничные случаи, тогда одобрю', 'Шаги 1–2 норм, шаг 3 надо переделать', 'Не согласен с выбором Redis, давай через Postgres',
    'Переделай план: миграция должна быть обратимой', 'Хорошо, но без удаления старого эндпоинта', 'Уберите рефакторинг, оставьте только фикс',
    'План ок при условии, что тесты будут в отдельном MR', 'Сначала опиши откат, потом одобрю', 'Нужно добавить обработку таймаута, без этого не одобряю',
    'Ок, только поменяй название ветки', 'Да, но давай без новой зависимости',
  ]),
  ...set('request_changes', 'en', [
    'LGTM, but fix the timeout first', 'Approve once the tests are in the plan', 'Not yet — split step 3 into two', 'Please change the schema before I approve',
    'OK except the migration of the users table', 'Good, but drop the refactoring part', 'Almost there; add rollback steps', 'No, use Postgres instead of Redis',
    'Fine if you remove the new dependency', 'I will approve after you add error handling for retries', 'Looks good apart from step 4, please rework it',
  ]),
  ...set('request_changes', 'mixed', ['LGTM, но надо тесты на edge cases', 'Ок, but please rename the endpoint']),
  ...set('question', 'ru', [
    'Почему Redis, а не Postgres?', 'А миграция обратимая?', 'Что будет при таймауте?', 'Сколько времени займёт реализация?',
    'Ты учёл нагрузку на пике?', 'Зачем нужен шаг 3?', 'Это затронет мобильный клиент?', 'Как будем откатывать, если что-то пойдёт не так?',
    'А тесты где будут лежать?', 'Почему не используем существующую очередь?',
  ]),
  ...set('question', 'en', [
    'Why Redis and not Postgres?', 'What happens on a timeout?', 'Does this touch the public API?', 'How do we roll this back?',
    'Have you checked the load at peak hours?', 'Why is step 3 needed?', 'Will this need a data migration?', 'Is this backward compatible?',
  ]),
  ...set('cancel', 'ru', [
    'Отмена, задача больше не нужна', 'Стоп', 'Отменяй, сделаем в следующем квартале', 'Не надо это делать, закрываем', 'Отмени задачу',
    'Прекращаем, требования поменялись полностью', 'Остановись, задачу сняли с приоритета',
  ]),
  ...set('cancel', 'en', [
    'Cancel, this is no longer needed', 'Stop, we are not doing this', '/cancel duplicate of another ticket', 'Abort, the requirement was dropped',
    'Please cancel the job', 'We decided not to do this, stop here',
  ]),
  ...set('unrelated', 'ru', [
    'Кто идёт на обед?', 'Встреча перенесена на 15:00', '@petya глянь, пожалуйста, логи прода', 'С днём рождения, Маша!', 'У кого есть зарядка для ноутбука?',
    'Деплой фронта сегодня в 18:00', 'Петя, ты закрыл свой тикет?',
  ]),
  ...set('unrelated', 'en', [
    'Who is up for lunch?', 'The standup moved to 3pm', '@anna can you check the prod logs?', 'Happy Friday everyone!', 'Anyone has a spare HDMI cable?',
    'Release notes for 2.4 are out',
  ]),
  ...set('unclear', 'ru', [
    'Ну да, конечно, гениальный план', 'хм', 'ок?', 'Наверное', 'Посмотрю позже', 'Да нет, наверное', 'Ага, щас', 'Ок... хотя не уверен',
    'Может быть', 'Не знаю, спрошу у Анны', 'Ну такое', 'Ладно, допустим', 'Без комментариев', '...', 'Ок, но я ещё подумаю',
    'Вроде норм, но надо подумать', 'Да делай что хочешь',
  ]),
  ...set('unclear', 'en', [
    'Sure, if you want to break prod', 'hmm', 'ok?', 'Maybe', 'I guess', 'Let me think about it', 'Not sure yet', 'Fine, whatever',
    'Interesting...', 'I will check with the team', 'Yeah right', 'Well, it could work', 'Kind of?',
  ]),
  ...set('unclear', 'mixed', ['Ну ok, maybe', 'LGTM? не уверен']),
]

/** Labels that approve: everything else must never approve. */
export const APPROVING: ReadonlySet<ReplyLabel> = new Set(['approve', 'approve_with_notes'])
