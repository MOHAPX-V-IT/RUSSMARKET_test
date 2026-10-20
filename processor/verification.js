import { processSnapshot, InputValidationError } from './engine.js';
import { scenarios } from '../fixtures/scenarios.js';

function fixture(id) {
  return structuredClone(scenarios.find((scenario) => scenario.id === id).data);
}

function check(name, assertion) {
  try {
    const detail = assertion();
    return { name, passed: true, detail: detail ?? 'Проверено.' };
  } catch (error) {
    return { name, passed: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectValidation(data, fragment) {
  try { processSnapshot(data); } catch (error) {
    assert(error instanceof InputValidationError, 'Ожидалась InputValidationError.');
    assert(error.issues.some((issue) => issue.includes(fragment)), `В issues нет «${fragment}».`);
    return;
  }
  throw new Error('Невалидный снимок был принят.');
}

// Проверки для браузера и Node.js.
export function runVerification() {
  return [
    check('Исходный порядок и сводка', () => {
      const result = processSnapshot(fixture('original'));
      assert(result.records.map((record) => record.id).join(',') === 'П-08,С-24,С-17,П-09', 'Неверный порядок.');
      assert(JSON.stringify(result.summary) === JSON.stringify({ total: 4, attention: 3, urgent: 2, review: 0, clear: 1 }), 'Неверная сводка.');
      return 'П-08 → С-24 → С-17 → П-09; 2 срочно, 1 внимание, 1 без действия.';
    }),
    check('Источники и ruleIds в результате', () => {
      const result = processSnapshot(fixture('original'));
      assert(result.records.every((record) => record.crmFacts.length && record.chatFacts.length && record.checks.length && record.ruleIds.length), 'Не хватает источников или проверок.');
      assert(result.records.find((record) => record.id === 'П-08').chatFacts[0].text === 'Задерживаюсь, раньше 13:00 не приеду', 'Исходное сообщение изменено.');
    }),
    check('Противоречие требует проверки', () => {
      const record = processSnapshot(fixture('contradiction')).records.find((item) => item.id === 'П-09');
      assert(record.priority === 'review' && record.needsAction && record.ruleIds.includes('DELIVERY_CONFLICT'), 'Конфликт принят как закрытый.');
    }),
    check('Недоступный источник не даёт clear', () => {
      const result = processSnapshot(fixture('source-unavailable'));
      assert(result.summary.review === 4 && result.summary.clear === 0, 'Недоступная CRM привела к clear.');
    }),
    check('Неизвестное сообщение не подтверждает приёмку', () => {
      const record = processSnapshot(fixture('unknown-message')).records.find((item) => item.id === 'П-09');
      assert(record.priority === 'review', 'Неизвестное сообщение принято за подтверждение.');
    }),
    check('Неподтверждённые формулировки не закрывают поставку', () => {
      for (const text of [
        'Карты якобы получили, количество проверили',
        'Не подтверждаю, что принял поставку',
        'Вы получили карты, количество проверили?',
        'Если получили карты, количество проверили?',
      ]) {
        const data = fixture('original');
        data.records.find((record) => record.id === 'П-09').messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === 'П-09');
        assert(record.priority === 'review' && record.ruleIds.includes('CHAT_UNCERTAIN'), `Фраза «${text}» принята за подтверждение.`);
        assert(/Вопрос, условие или предположение/.test(record.chatFacts[0].interpretation), 'Не объяснён результат ручной проверки.');
      }
    }),
    check('Расхождение и неизвестное продолжение не закрывают поставку', () => {
      for (const text of [
        'Карты получили, количество проверили: не хватает пяти карт',
        'Карты получили не все, количество проверили',
        'Упаковка вскрыта, номера не совпадают',
        'Карты получили, количество проверили, спасибо',
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.needsAction && record.requiresManualReview && record.priority !== 'clear', `«${text}» ошибочно закрывает поставку.`);
        assert(record.checks.length && record.actions.length, 'Нет проверки и следующего шага.');
      }
    }),
    check('Документы не подтверждают получение карт', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      target.messages[0].text = 'Документы получили, количество карт проверили. Карты пока ждём';
      const record = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(record.requiresManualReview && record.ruleIds.includes('DELIVERY_CARDS_PENDING'), 'Получение документов принято за получение карт.');
      assert(record.actions.some((action) => action.includes('передачей карт')), 'Нет конкретного следующего шага.');
    }),
    check('Поставка как объект получения принимается без неизвестных продолжений', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      target.messages[0].text = 'Получил поставку, проверил количество';
      const record = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(record.priority === 'clear' && !record.needsAction, 'Подтверждённая поставка ошибочно отправлена на проверку.');
      target.messages[0].text += ', есть расхождения';
      const amended = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(amended.requiresManualReview, 'Продолжение с расхождением было проигнорировано.');
    }),
    check('Понятные кадровые сообщения могут закрыться после подтверждения CRM', () => {
      const data = fixture('original');
      const onboarding = data.records.find((record) => record.type === 'onboarding');
      onboarding.crm.status = 'ready';
      onboarding.crm.documentsConfirmed = true;
      const offboarding = data.records.find((record) => record.type === 'offboarding');
      offboarding.crm.status = 'confirmed';
      offboarding.crm.managerConfirmed = true;
      const result = processSnapshot(data);
      for (const source of [onboarding, offboarding]) {
        const record = result.records.find((item) => item.id === source.id);
        assert(record.priority === 'clear' && !record.needsAction, `Понятная запись ${source.id} не закрылась.`);
      }
    }),
    check('Неизвестный хвост запрещает clear в кадровых сообщениях', () => {
      for (const [type, extra] of [
        ['onboarding', 'Документы чужие.'],
        ['offboarding', 'Подтверждение отозвано.'],
        ['onboarding', 'Остались вопросы по комплекту.'],
        ['offboarding', 'Нужно ещё разобраться.'],
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === type);
        if (type === 'onboarding') {
          target.crm.status = 'ready'; target.crm.documentsConfirmed = true;
        } else {
          target.crm.status = 'confirmed'; target.crm.managerConfirmed = true;
        }
        target.messages[0].text += `. ${extra}`;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.requiresManualReview && record.priority !== 'clear', `Хвост «${extra}» был проигнорирован.`);
        assert(record.checks.length && record.actions.length, 'Нет шага ручной проверки.');
      }
    }),
    check('Активные кадровые сроки сохраняют приоритет и требуют сверки контекста', () => {
      for (const [type, extra, priority, ruleId] of [
        ['onboarding', 'Документы чужие', 'attention', 'ONBOARDING_CONTEXT_REVIEW'],
        ['offboarding', 'Увольнение отменено', 'urgent', 'OFFBOARDING_CONTEXT_REVIEW'],
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === type);
        target.messages[0].text += `. ${extra}`;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === priority && record.requiresManualReview && record.ruleIds.includes(ruleId), `Контекст ${type} проигнорирован.`);
        assert(/актуальн/i.test(record.actions[0]) && /актуальн/i.test(record.checks[0]), 'Нет предметной сверки актуальности.');
      }
    }),
    check('Неизвестная вводная не подтверждает повреждение после двоеточия', () => {
      for (const text of [
        'Это неправда: карты повреждены',
        'Ошибочная информация: карты повреждены',
        'Не пишите: карты повреждены',
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.requiresManualReview && !record.ruleIds.includes('DELIVERY_DISCREPANCY'), `Вводная «${text}» стала фактом повреждения.`);
        assert(!/Зафиксировать расхождение/.test(record.actions[0]), 'Рекомендовано фиксировать неподтверждённое расхождение.');
      }
      const positive = fixture('original');
      const target = positive.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      target.messages[0].text = 'Карты получили, количество проверили: не хватает пяти карт';
      assert(processSnapshot(positive).records.find((item) => item.id === target.id).ruleIds.includes('DELIVERY_DISCREPANCY'), 'Подтверждённая недостача потеряна.');
    }),
    check('Время без даты не доказывает задержку относительно CRM', () => {
      for (const text of ['Приеду после 08:00', 'Не успею к 08:00', 'После 13:00 приеду']) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        target.crm.dueAt = '2026-10-19T12:00:00+03:00';
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.requiresManualReview && record.ruleIds.includes('DELIVERY_WINDOW_REVIEW'), `Время «${text}» не отправлено на уточнение.`);
        assert(!record.ruleIds.includes('DELIVERY_DELAY') && !record.ruleIds.includes('DELIVERY_DELAY_RISK'), 'Нижняя граница стала задержкой.');
        assert(/дату и полное окно/.test(record.actions[0]), 'Нет шага уточнения даты и окна.');
      }
    }),
    check('Срок поставки срочный независимо от вопроса и отрицания задержки', () => {
      for (const [text, delayExpected] of [
        ['Не задерживаюсь, приеду вовремя', false],
        ['Задерживаюсь, раньше 13:00 не приеду. Кого предупредить?', true],
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === 'urgent' && record.deadlineReached && record.needsAction, `Потеряна срочность: «${text}».`);
        assert(record.ruleIds.includes(delayExpected ? 'DELIVERY_DELAY' : 'DELIVERY_DUE_UNCONFIRMED'), `Неверная трактовка задержки: «${text}».`);
      }
    }),
    check('Противоречивые сообщения курьера требуют сверки задержки', () => {
      for (const crossMessage of [false, true]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        if (crossMessage) target.messages.push({ id: 'm-08-denial', author: 'Курьер', text: 'Не задерживаюсь, приеду вовремя' });
        else target.messages[0].text = 'Не задерживаюсь. Задерживаюсь';
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === 'urgent' && record.requiresManualReview && record.needsAction, 'Противоречие или срочность потеряны.');
        assert(record.ruleIds.includes('DELIVERY_DELAY_CONFLICT') && /задержк/i.test(record.actions[0]), 'Нет первого шага сверки задержки.');
      }
    }),
    check('Непонятный хвост сообщения курьера остаётся виден и проверяется', () => {
      for (const [text, dueAt, priority] of [
        ['Задерживаюсь. Везу карты на другую точку', '2026-10-19T10:00:00+03:00', 'urgent'],
        ['Задерживаюсь. Везу карты на другую точку', '2026-10-19T12:00:00+03:00', 'attention'],
        ['Не задерживаюсь. Карты потеряны', '2026-10-19T10:00:00+03:00', 'urgent'],
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        target.crm.dueAt = dueAt;
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === priority && record.requiresManualReview && record.needsAction, 'Непонятное продолжение или приоритет потеряны.');
        assert(record.ruleIds.includes('DELIVERY_CONTEXT_REVIEW') && /контекст/i.test(record.actions[0]), 'Нет первого шага проверки всего контекста.');
        assert(/не распознана|Нераспознанный фрагмент/.test(record.chatFacts[0].interpretation) && /карт/i.test(record.chatFacts[0].interpretation), 'Непонятный фрагмент не показан как исходное сообщение.');
      }
    }),
    check('Отрицания задержки не превращаются в сообщение о задержке', () => {
      for (const text of [
        'Не опоздаю, приеду вовремя',
        'Задержек нет, приеду вовремя',
        'Нет задержек, приеду вовремя',
        'Без задержек, приеду вовремя',
      ]) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === 'urgent' && record.deadlineReached, 'Наступивший срок потерян.');
        assert(!record.ruleIds.includes('DELIVERY_DELAY') && !/сообщил о задержке/.test(record.headline), `Ложная задержка: «${text}».`);
      }
    }),
    check('Неподтверждённая задержка требует ручной проверки', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
      target.messages[0].text = 'Задержка не подтверждена, еду по плану';
      const record = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(record.priority === 'urgent' && record.requiresManualReview && !record.ruleIds.includes('DELIVERY_DELAY'), 'Неподтверждённая задержка стала фактом.');
      assert(/не подтверждена/.test(record.chatFacts[0].interpretation), 'Интерпретация не отражает неопределённость.');
    }),
    check('Нераспознанное утверждение о задержке не становится фактом', () => {
      for (const text of ['Задержка не выявлена, еду по плану', 'Не могу подтвердить задержку']) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        target.messages[0].text = text;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.priority === 'urgent' && record.requiresManualReview, 'Срок или ручная проверка потеряны.');
        assert(!record.ruleIds.includes('DELIVERY_DELAY') && !/сообщил о задержке/.test(record.headline), `Ложный факт задержки: «${text}».`);
      }
    }),
    check('Отсутствие расхождений не скрывает отдельную недостачу', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      target.messages[0].text = 'Карты получили, количество проверили. Расхождений нет';
      const clean = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(clean.priority === 'clear' && !clean.ruleIds.includes('DELIVERY_DISCREPANCY'), 'Отрицание ошибочно стало расхождением.');
      target.messages[0].text = 'Карты получили, количество проверили. Расхождений нет, но не хватает пяти карт';
      const mixed = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(mixed.requiresManualReview && mixed.ruleIds.includes('DELIVERY_DISCREPANCY'), 'Отрицание скрыло реальную недостачу.');
      assert(/Зафиксировать расхождение/.test(mixed.actions[0]), 'Предметный шаг не стоит первым.');
    }),
    check('Неподтверждённое расхождение не ведёт к действию о недостаче', () => {
      for (const tail of ['Недостачи не обнаружено', 'Несоответствий нет']) {
        const data = fixture('original');
        const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
        target.messages[0].text += `. ${tail}`;
        const record = processSnapshot(data).records.find((item) => item.id === target.id);
        assert(record.requiresManualReview && !record.ruleIds.includes('DELIVERY_DISCREPANCY'), `Отрицание «${tail}» стало расхождением.`);
        assert(!record.actions.some((action) => action.includes('Зафиксировать расхождение')), 'Предписано фиксировать несуществующее расхождение.');
      }
    }),
    check('Отрицание ожидания карт не превращается в факт ожидания', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      target.messages[0].text = 'Карты получили, количество проверили. Карты ждать не надо';
      const record = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(record.requiresManualReview && !record.ruleIds.includes('DELIVERY_CARDS_PENDING'), 'Отрицание стало ожиданием карт.');
      assert(!/карты еще ожидаются|карты ещё ожидаются/i.test(record.headline), 'Headline приписал ожидание карт.');
      target.messages[0].text = 'Документы получили, количество карт проверили. Карты пока ждём';
      const waiting = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(waiting.ruleIds.includes('DELIVERY_CARDS_PENDING'), 'Явное ожидание карт потеряно.');
    }),
    check('Отрицание прибытия вовремя не считается обещанием срока', () => {
      const data = fixture('original');
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
      target.messages[0].text = 'Вовремя не приеду';
      const record = processSnapshot(data).records.find((item) => item.id === target.id);
      assert(record.priority === 'urgent' && record.requiresManualReview, 'Срочный неясный случай не отправлен на проверку.');
      assert(!record.ruleIds.includes('DELIVERY_DELAY'), 'Нераспознанная фраза ошибочно стала подтверждённой задержкой.');
    }),
    check('Наступивший срок и ручная проверка сохраняются одновременно', () => {
      const data = fixture('original');
      data.sources.chat = 'partial';
      const target = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
      const result = processSnapshot(data);
      const record = result.records.find((item) => item.id === target.id);
      assert(record.priority === 'urgent' && record.requiresManualReview && record.deadlineReached, 'Срочность или ручная проверка потеряна.');
      assert(result.summary.review > 0 && result.summary.urgent > 0, 'Сводка не учитывает оба признака.');
    }),
    check('Автор сообщения важен для приёмки', () => {
      const data = fixture('original');
      data.records.find((record) => record.id === 'П-09').messages[0].author = 'Курьер';
      assert(processSnapshot(data).records.find((record) => record.id === 'П-09').priority === 'review', 'Слова курьера приняты за подтверждение получателя.');
    }),
    check('Составная роль не подтверждает приёмку, точный псевдоним подтверждает', () => {
      for (const author of ['Курьер со слов получателя', 'Представитель банка, не получатель']) {
        const data = fixture('original');
        const source = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
        source.messages[0].author = author;
        const record = processSnapshot(data).records.find((item) => item.id === source.id);
        assert(record.priority === 'review' && record.requiresManualReview && record.ruleIds.includes('DELIVERY_AUTHOR_REVIEW'), `Составная роль «${author}» подтвердила приёмку.`);
        assert(/автор/i.test(record.actions[0]) && record.chatFacts[0].author === author, 'Автор не сохранён или нет шага сверки.');
      }
      const data = fixture('original');
      const source = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      source.messages[0].author = '  СОтрудник   СКЛАДА  ';
      assert(processSnapshot(data).records.find((item) => item.id === source.id).priority === 'clear', 'Точная роль после нормализации не распознана.');
    }),
    check('Чужое сообщение не наследует роль другого автора', () => {
      const data = fixture('original');
      const source = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'accepted');
      source.messages.push({ id: 'other-author', author: 'Представитель банка', text: 'Карты получили, количество проверили' });
      const record = processSnapshot(data).records.find((item) => item.id === source.id);
      assert(record.priority === 'review' && record.requiresManualReview && record.ruleIds.includes('DELIVERY_AUTHOR_REVIEW'), 'Подтверждение получателя ошибочно распространилось на другого автора.');
      assert(/автор/i.test(record.actions[0]), 'Нет первого шага сверки автора.');
    }),
    check('Некурьерское сообщение о задержке не становится сообщением курьера', () => {
      for (const [dueAt, priority] of [
        ['2026-10-19T10:00:00+03:00', 'urgent'],
        ['2026-10-19T15:00:00+03:00', 'review'],
      ]) {
        const data = fixture('original');
        const source = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        source.crm.dueAt = dueAt;
        source.messages[0].author = 'Получатель';
        const record = processSnapshot(data).records.find((item) => item.id === source.id);
        assert(record.priority === priority && record.requiresManualReview && record.ruleIds.includes('DELIVERY_AUTHOR_REVIEW'), 'Чужое сообщение стало курьерской задержкой.');
        assert(/автор/i.test(record.actions[0]) && !/курьер/i.test(record.actions[0]), 'Первый шаг приписывает слова курьеру.');
        assert(!/курьер сообщил|риск срыва/i.test(record.headline + record.actions.join(' ') + record.chatFacts[0].interpretation), 'Выведен неподтверждённый курьерский факт.');
      }
    }),
    check('Чужое отрицание и ETA не меняют сообщение курьера', () => {
      for (const text of ['Не задерживаюсь, приеду вовремя', 'Приеду после 13:00']) {
        const data = fixture('original');
        const source = data.records.find((record) => record.type === 'delivery' && record.crm.status === 'in_transit');
        source.messages.push({ id: 'other-author', author: 'Получатель', text });
        const record = processSnapshot(data).records.find((item) => item.id === source.id);
        assert(record.priority === 'urgent' && record.requiresManualReview && record.ruleIds.includes('DELIVERY_AUTHOR_REVIEW'), 'Чужая фраза изменила статус без проверки автора.');
        assert(!record.ruleIds.includes('DELIVERY_DELAY_CONFLICT') && /автор/i.test(record.actions[0]), 'Чужой голос создан как курьерский конфликт.');
      }
    }),
    check('Будущее сообщение не является текущим фактом', () => {
      const data = fixture('original');
      data.records.find((record) => record.id === 'П-09').messages[0].at = '2026-10-19T10:01:00+03:00';
      assert(processSnapshot(data).records.find((record) => record.id === 'П-09').priority === 'review', 'Будущее сообщение использовано.');
    }),
    check('Отрицания не считаются подтверждениями', () => {
      const data = fixture('original');
      data.records.find((record) => record.id === 'С-17').messages[0].text = 'Не отправил фотографии документов руководителю в личку';
      data.records.find((record) => record.id === 'П-09').messages[0].text = 'Карты не получили, количество не проверили';
      const result = processSnapshot(data);
      assert(!result.records.find((record) => record.id === 'С-17').ruleIds.includes('ONBOARDING_PRIVATE_CHANNEL'), '«Не отправил» распознано как отправка.');
      assert(result.records.find((record) => record.id === 'П-09').priority === 'review', '«Не получили» принято за получение.');
    }),
    check('Неверные даты и ISO отклоняются', () => {
      const data = fixture('original');
      data.records[0].crm.firstDay = '2026-02-30';
      expectValidation(data, 'firstDay');
      const second = fixture('original');
      second.records[2].crm.dueAt = '2026-10-19T25:00:00+03:00';
      expectValidation(second, 'dueAt');
    }),
    check('Повторные record.id и message.id внутри записи отклоняются', () => {
      const data = fixture('original');
      data.records[1].id = data.records[0].id;
      expectValidation(data, '.id');
      const second = fixture('original');
      second.records[1].messages.push({ ...second.records[1].messages[0] });
      expectValidation(second, '.id');
      const third = fixture('original');
      third.records[1].messages[0].id = third.records[0].messages[0].id;
      assert(processSnapshot(third).summary.total === 4, 'Одинаковые message.id в разных записях ошибочно отклонены.');
    }),
    check('Срок наступает ровно в 10:00 МСК', () => {
      const data = fixture('original');
      data.asOf = '2026-10-19T07:00:00Z';
      const record = processSnapshot(data).records.find((item) => item.id === 'П-08');
      assert(record.priority === 'urgent', 'Момент дедлайна не распознан.');
    }),
    check('Воспроизводимость и отсутствие мутаций', () => {
      const data = fixture('original');
      const before = JSON.stringify(data);
      const first = processSnapshot(data);
      const second = processSnapshot(data);
      assert(JSON.stringify(data) === before, 'Входные данные изменены.');
      assert(JSON.stringify(first) === JSON.stringify(second), 'Результаты разных запусков отличаются.');
    }),
  ];
}
