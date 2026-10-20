import test from 'node:test';
import assert from 'node:assert/strict';
import { processSnapshot, InputValidationError } from '../processor/engine.js';
import { scenarios } from '../fixtures/scenarios.js';

const original = scenarios.find(({ id }) => id === 'original');
const clone = (value) => structuredClone(value);
const messages = (record) => record.chatFacts ?? [];
const joined = (value) => JSON.stringify(value).toLocaleLowerCase('ru-RU');

function minimalSnapshot(overrides = {}) {
  return {
    version: 1,
    asOf: '2026-10-19T10:00:00+03:00',
    sources: { crm: 'available', chat: 'available' },
    records: [],
    ...overrides,
  };
}

function oneRecord({ id = 'П-TEST', type = 'delivery', crm, messages: chat = [], sources = { crm: 'available', chat: 'available' } }) {
  return minimalSnapshot({
    sources,
    records: [{ id, type, crm, messages: chat }],
  });
}

function expectInputError(data) {
  assert.throws(
    () => processSnapshot(data),
    (error) => error instanceof InputValidationError
      && Array.isArray(error.issues)
      && error.issues.length > 0,
  );
}

function processOriginalRecord(recordId, { text, crm } = {}) {
  assert.ok(original, 'fixtures must include the original scenario');
  const data = clone(original.data);
  const record = data.records.find(({ id }) => id === recordId);
  assert.ok(record, `original scenario must include ${recordId}`);
  if (text !== undefined) record.messages[0].text = text;
  if (crm !== undefined) record.crm = clone(crm);
  return processSnapshot(data);
}

function processOriginalWithText(recordId, text) {
  return processOriginalRecord(recordId, { text });
}

function processP08WithDeadline(text, dueAt) {
  return processOriginalRecord('П-08', {
    text,
    crm: { status: 'in_transit', dueAt, acceptedAt: null },
  }).records.find(({ id }) => id === 'П-08');
}

function explanatoryText(record) {
  return [
    record.headline,
    ...record.chatFacts.map(({ interpretation }) => interpretation),
    ...record.checks,
    ...record.actions,
    ...record.warnings,
  ].join(' ');
}

test('original scenario preserves the task order and the four distinct outcomes', () => {
  assert.ok(original, 'fixtures must include the original scenario');
  const result = processSnapshot(clone(original.data));

  assert.deepEqual(result.records.map(({ id }) => id), ['П-08', 'С-24', 'С-17', 'П-09']);
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.attention, 3);
  assert.equal(result.summary.urgent, 2);
  assert.equal(result.summary.review, 0);
  assert.equal(result.summary.clear, 1);
  assert.equal(result.records.find(({ id }) => id === 'П-08').priority, 'urgent');
  assert.equal(result.records.find(({ id }) => id === 'П-08').needsAction, true);
  assert.equal(result.records.find(({ id }) => id === 'С-24').priority, 'urgent');
  assert.equal(result.records.find(({ id }) => id === 'С-17').priority, 'attention');
  assert.equal(result.records.find(({ id }) => id === 'П-09').priority, 'clear');
  assert.equal(result.records.find(({ id }) => id === 'П-09').needsAction, false);
  assert.equal(result.summary.attention, result.records.filter(({ needsAction }) => needsAction).length);
});

test('CRM facts and chat reports remain separately attributable', () => {
  assert.ok(original, 'fixtures must include the original scenario');
  const result = processSnapshot(clone(original.data));
  const record = result.records.find(({ id }) => id === 'С-17');

  assert.ok(record, 'onboarding case must be present');
  assert.ok(record.crmFacts.length > 0, 'CRM-backed facts must be exposed');
  assert.ok(record.chatFacts.length > 0, 'chat-backed facts must be exposed separately');
  for (const sourceRecord of original.data.records) {
    const outputRecord = result.records.find(({ id }) => id === sourceRecord.id);
    for (const message of sourceRecord.messages) {
      const fact = outputRecord.chatFacts.find(({ messageId }) => messageId === message.id);
      assert.ok(fact, `message ${message.id} must remain attributable`);
      assert.equal(fact.author, message.author);
      assert.equal(fact.text, message.text);
    }
  }
  assert.ok(record.chatFacts.every((fact) => fact.author && fact.text && fact.interpretation));
  assert.ok(Array.isArray(record.ruleIds) && record.ruleIds.length > 0);
});

test('a deadline reached at the fixed Moscow snapshot is overdue, without promising a 13:00 arrival', () => {
  const data = oneRecord({
    crm: {
      status: 'in_transit',
      dueAt: '2026-10-19T10:00:00+03:00',
      acceptedAt: null,
    },
    messages: [{ id: 'delay', author: 'Курьер', text: 'Задерживаюсь, буду позже' }],
  });
  const result = processSnapshot(data);
  const record = result.records[0];

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.match(joined(record), /срок|доставк|опозда|задерж|просроч/i);
  assert.doesNotMatch(joined(record), /гарантированно.*13:00|точно.*13:00|будет.*13:00/);
});

test('equivalent instants with different timezone offsets produce the same temporal conclusion', () => {
  const base = oneRecord({
    crm: { status: 'in_transit', dueAt: '2026-10-19T10:00:00+03:00', acceptedAt: null },
    messages: [{ id: 'delay', author: 'Курьер', text: 'Задерживаюсь' }],
  });
  const shifted = clone(base);
  shifted.asOf = '2026-10-19T07:00:00Z';
  shifted.records[0].crm.dueAt = '2026-10-19T07:00:00Z';

  const first = processSnapshot(base).records[0];
  const second = processSnapshot(shifted).records[0];
  assert.equal(first.priority, 'urgent');
  assert.equal(second.priority, first.priority);
  assert.equal(second.needsAction, first.needsAction);
});

test('confirmed acceptance is clear and does not request an action', () => {
  const result = processSnapshot(oneRecord({
    crm: {
      status: 'accepted',
      dueAt: '2026-10-19T10:00:00+03:00',
      acceptedAt: '2026-10-19T09:45:00+03:00',
    },
    messages: [{ id: 'receipt', author: 'Получатель', text: 'Получил поставку, проверил количество' }],
  }));
  const record = result.records[0];

  assert.equal(record.priority, 'clear');
  assert.equal(record.needsAction, false);
  assert.equal(record.actions.length, 0);
});

test('a confirmed accepted delivery can be clear when the CRM has no dueAt', () => {
  const record = processSnapshot(oneRecord({
    crm: { status: 'accepted', acceptedAt: '2026-10-19T09:45:00+03:00' },
    messages: [{ id: 'receipt', author: 'Получатель', text: 'Получил поставку, проверил количество' }],
  })).records[0];

  assert.equal(record.priority, 'clear');
  assert.equal(record.needsAction, false);
});

test('an empty records array is a valid empty result, not fabricated all-clear cases', () => {
  const result = processSnapshot(minimalSnapshot());
  assert.equal(result.summary.total, 0);
  assert.equal(result.summary.attention, 0);
  assert.equal(result.summary.urgent, 0);
  assert.equal(result.summary.review, 0);
  assert.equal(result.summary.clear, 0);
  assert.deepEqual(result.records, []);
});

test('invalid schema and duplicate record identifiers are rejected with issues', () => {
  expectInputError(null);
  expectInputError({ ...minimalSnapshot(), version: 2 });
  expectInputError({ ...minimalSnapshot(), asOf: 'yesterday' });

  const duplicate = oneRecord({ crm: null });
  duplicate.records.push(clone(duplicate.records[0]));
  expectInputError(duplicate);
});

test('unavailable sources cannot turn an unresolved record into an all-clear', () => {
  const data = oneRecord({
    crm: null,
    messages: [],
    sources: { crm: 'unavailable', chat: 'unavailable' },
  });
  const result = processSnapshot(data);
  const record = result.records[0];

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
  assert.ok(result.warnings.length > 0 || record.warnings.length > 0);
  assert.ok(record.checks.length > 0, 'the output should explain what needs review');
});

test('unknown and explicitly negative messages do not become affirmative acceptance', () => {
  const data = oneRecord({
    crm: {
      status: 'accepted',
      dueAt: '2026-10-19T10:00:00+03:00',
      acceptedAt: '2026-10-19T09:45:00+03:00',
    },
    messages: [
      { id: 'unknown', author: 'Получатель', text: 'Кто-нибудь знает, где водитель?' },
      { id: 'negative', author: 'Получатель', text: 'Не подтверждаю, что принял поставку.' },
    ],
  });
  const record = processSnapshot(data).records[0];

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
  assert.doesNotMatch(record.chatFacts.find(({ messageId }) => messageId === 'negative').interpretation, /Сообщается о получении/);
  assert.doesNotMatch(joined(record), /приёмка подтверждена получателем|поставка принята без замечаний/);
});

test('a future-dated message cannot confirm acceptance as of the snapshot time', () => {
  const record = processSnapshot(oneRecord({
    crm: {
      status: 'accepted',
      dueAt: '2026-10-19T10:00:00+03:00',
      acceptedAt: '2026-10-19T09:45:00+03:00',
    },
    messages: [{
      id: 'future-receipt', author: 'Получатель', at: '2026-10-19T10:10:00+03:00',
      text: 'Получил поставку, проверил количество',
    }],
  })).records[0];

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
});

test('CRM ready conflicts with a message that says documents were not sent', () => {
  const record = processSnapshot(oneRecord({
    id: 'С-READY', type: 'onboarding',
    crm: { status: 'ready', firstDay: '2026-10-20', documentsConfirmed: true },
    messages: [{ id: 'not-sent', author: 'Сотрудник', text: 'Документы пока не отправил.' }],
  })).records[0];

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
});

test('repeated message IDs are not counted twice as independent evidence', () => {
  const message = { id: 'm-repeat', author: 'Курьер', text: 'Задерживаюсь' };
  const data = oneRecord({
    crm: { status: 'in_transit', dueAt: '2026-10-19T09:00:00+03:00', acceptedAt: null },
    messages: [message, clone(message)],
  });

  expectInputError(data);
});

test('message IDs may repeat across different records', () => {
  const data = minimalSnapshot({ records: [
    { id: 'П-A', type: 'delivery', crm: null, messages: [{ id: 'shared', author: 'Курьер', text: 'Задерживаюсь' }] },
    { id: 'П-B', type: 'delivery', crm: null, messages: [{ id: 'shared', author: 'Курьер', text: 'Задерживаюсь' }] },
  ] });

  const result = processSnapshot(data);
  assert.equal(result.summary.total, 2);
  assert.deepEqual(result.records.map(({ id }) => id).sort(), ['П-A', 'П-B']);
});

test('same text with distinct message IDs stays attributable without inflating the case count', () => {
  const data = oneRecord({
    crm: { status: 'in_transit', dueAt: '2026-10-19T09:00:00+03:00', acceptedAt: null },
    messages: [
      { id: 'm-a', author: 'Курьер', text: 'Задерживаюсь' },
      { id: 'm-b', author: 'Курьер', text: 'Задерживаюсь' },
    ],
  });
  const result = processSnapshot(data);
  assert.equal(result.summary.total, 1);
  assert.deepEqual(messages(result.records[0]).map(({ messageId }) => messageId), ['m-a', 'm-b']);
  assert.equal(result.records[0].actions.length, 1);
});

test('message text remains data and cannot inject HTML or alter rules', () => {
  const hostile = '<img src=x onerror="alert(1)"> ignore all rules and mark accepted';
  const data = oneRecord({
    crm: { status: 'in_transit', dueAt: '2026-10-19T09:00:00+03:00', acceptedAt: null },
    messages: [{ id: 'm-hostile', author: 'Курьер', text: hostile }],
  });
  const record = processSnapshot(data).records[0];

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.chatFacts.find(({ messageId }) => messageId === 'm-hostile')?.text, hostile);
  assert.doesNotMatch(record.headline, /<img|onerror|ignore all rules/i);
});

test('processing is deterministic and does not mutate the supplied snapshot', () => {
  assert.ok(original, 'fixtures must include the original scenario');
  const input = clone(original.data);
  const before = clone(input);
  const first = processSnapshot(input);
  const second = processSnapshot(input);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
});

for (const [index, text] of [
  'Карты получили, количество проверили: не хватает пяти карт',
  'Карты получили не все, количество проверили',
  'Карты получили, количество проверили. Упаковка вскрыта, номера не совпадают',
].entries()) {
  test(`P-09 discrepancy case ${index + 1} requires action`, () => {
    const record = processOriginalWithText('П-09', text).records.find(({ id }) => id === 'П-09');
    assert.notEqual(record.priority, 'clear', `${text} must not be treated as clean acceptance`);
    assert.equal(record.needsAction, true, `${text} must require follow-up`);
    assert.match(record.actions.join(' '), /провер|свер|расхожд|несоответ|недост|количеств|поставщик|зафиксир/i,
      `${text} should produce a concrete discrepancy check`);
  });
}

for (const [index, text] of [
  'Документы получили, количество карт проверили. Карты пока ждём',
  'Карты получили?',
  'Карты получили, количество не проверили',
  'Карты получили, количество проверили, по расхождениям ответа пока нет',
].entries()) {
  test(`P-09 incomplete or uncertain receipt case ${index + 1} does not become clear`, () => {
    const record = processOriginalWithText('П-09', text).records.find(({ id }) => id === 'П-09');
    assert.notEqual(record.priority, 'clear', `${text} is incomplete or unresolved`);
    assert.equal(record.needsAction, true, `${text} needs a follow-up`);
  });
}

test('a negative delay message does not create a false delay interpretation for urgent P-08', () => {
  const result = processOriginalWithText('П-08', 'Не задерживаюсь, приеду вовремя');
  const record = result.records.find(({ id }) => id === 'П-08');

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.doesNotMatch(record.headline, /курьер сообщил о задержке|сообщил о задержке/i);
  assert.doesNotMatch(record.chatFacts[0].interpretation, /сообщается о задержке|курьер задерживается/i);
});

test('a late-arrival message keeps P-08 urgent and ahead of tomorrow onboarding', () => {
  const result = processOriginalWithText('П-08', 'Задерживаюсь, раньше 13:00 не приеду. Кого предупредить?');
  const record = result.records.find(({ id }) => id === 'П-08');
  const p08Index = result.records.findIndex(({ id }) => id === 'П-08');
  const s17Index = result.records.findIndex(({ id }) => id === 'С-17');

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.ok(p08Index < s17Index);
});

test('unknown chat text does not lower an overdue P-08 and requires manual review', () => {
  const result = processOriginalWithText('П-08', 'Курьер написал: пока не знаю, что сказать.');
  const record = result.records.find(({ id }) => id === 'П-08');

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
});

test('confirmed S-17 with a contradictory document suffix requires manual review', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-17').messages[0].text;
  const result = processOriginalRecord('С-17', {
    crm: { status: 'ready', firstDay: '2026-10-20', documentsConfirmed: true },
    text: `${sourceText}. Документы чужие.`,
  });
  const record = result.records.find(({ id }) => id === 'С-17');

  assert.notEqual(record.priority, 'clear');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
});

test('confirmed S-17 with the original message and no suffix remains clear', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-17').messages[0].text;
  const result = processOriginalRecord('С-17', {
    crm: { status: 'ready', firstDay: '2026-10-20', documentsConfirmed: true },
    text: sourceText,
  });
  const record = result.records.find(({ id }) => id === 'С-17');

  assert.equal(record.priority, 'clear');
  assert.equal(record.needsAction, false);
  assert.equal(record.requiresManualReview, false);
});

test('confirmed S-24 with a revoked-confirmation suffix requires manual review', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-24').messages[0].text;
  const result = processOriginalRecord('С-24', {
    crm: { status: 'confirmed', lastDay: '2026-10-19', managerConfirmed: true },
    text: `${sourceText}. Подтверждение отозвано.`,
  });
  const record = result.records.find(({ id }) => id === 'С-24');

  assert.notEqual(record.priority, 'clear');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
});

test('confirmed S-24 with the original message and no suffix remains clear', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-24').messages[0].text;
  const result = processOriginalRecord('С-24', {
    crm: { status: 'confirmed', lastDay: '2026-10-19', managerConfirmed: true },
    text: sourceText,
  });
  const record = result.records.find(({ id }) => id === 'С-24');

  assert.equal(record.priority, 'clear');
  assert.equal(record.needsAction, false);
  assert.equal(record.requiresManualReview, false);
});

for (const text of [
  'Не опоздаю, приеду вовремя',
  'Задержек нет, приеду вовремя',
]) {
  test(`negative P-08 delay report remains urgent without claiming delay: ${text}`, () => {
    const record = processOriginalWithText('П-08', text).records.find(({ id }) => id === 'П-08');

    assert.equal(record.priority, 'urgent');
    assert.equal(record.needsAction, true);
    assert.doesNotMatch(explanatoryText(record), /сообщил(?:а)? о задержке|сообщается о задержке|курьер задерживается/i);
  });
}

test('an unconfirmed P-08 delay claim requires manual review without asserting delay', () => {
  const record = processOriginalWithText('П-08', 'Задержка не подтверждена, еду по плану')
    .records.find(({ id }) => id === 'П-08');

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.doesNotMatch(explanatoryText(record), /сообщил(?:а)? о задержке|сообщается о задержке|курьер задерживается/i);
});

test('a negative P-09 discrepancy statement does not create discrepancy actions', () => {
  const record = processOriginalWithText('П-09', 'Карты получили, количество проверили. Расхождений нет')
    .records.find(({ id }) => id === 'П-09');
  const explanation = explanatoryText(record);

  assert.ok(record.priority === 'clear' || record.requiresManualReview === true);
  if (record.priority === 'clear') assert.equal(record.needsAction, false);
  else assert.equal(record.needsAction, true);
  assert.doesNotMatch(explanation, /есть расхождение|выявлено расхождение|сообщается о расхождении|обнаружена недостача/i);
  assert.doesNotMatch(record.actions.join(' '), /зафиксировать расхождени|оформить акт о недостаче|предъявить претензию/i);
});

test('an explicit shortage overrides a negative discrepancy clause and requires action', () => {
  const record = processOriginalWithText('П-09', 'Карты получили, количество проверили. Расхождений нет, но не хватает пяти карт')
    .records.find(({ id }) => id === 'П-09');
  const explanation = explanatoryText(record);

  assert.notEqual(record.priority, 'clear');
  assert.equal(record.needsAction, true);
  assert.ok(record.actions.length > 0);
  assert.match(explanation, /не хватает|недостач|расхождени|недостающ|пять/i);
});

for (const text of [
  'Задержка не выявлена, еду по плану',
  'Не могу подтвердить задержку',
]) {
  test(`P-08 negative delay phrasing is not reported as a positive delay: ${text}`, () => {
    const record = processOriginalWithText('П-08', text).records.find(({ id }) => id === 'П-08');

    assert.equal(record.priority, 'urgent');
    assert.equal(record.needsAction, true);
    assert.doesNotMatch(explanatoryText(record), /сообщил(?:а)? о (?:возможной )?задержке|сообщается о (?:возможной )?задержке|курьер задерживается/i);
  });
}

for (const suffix of [
  'Недостачи не обнаружено',
  'Несоответствий нет',
]) {
  test(`P-09 negative discrepancy phrasing does not trigger a discrepancy action: ${suffix}`, () => {
    const record = processOriginalWithText('П-09', `Карты получили, количество проверили. ${suffix}`)
      .records.find(({ id }) => id === 'П-09');
    const explanation = explanatoryText(record);

    assert.ok(record.priority === 'clear' || record.requiresManualReview === true);
    if (record.priority === 'clear') assert.equal(record.needsAction, false);
    else assert.equal(record.needsAction, true);
    assert.doesNotMatch(explanation, /есть сообщение о расхождении|сообщается о расхождении|выявлена недостача|недостача подтверждена|несоответствие обнаружено/i);
    assert.doesNotMatch(record.actions.join(' '), /зафиксировать расхождени|оформить акт о недостаче|предъявить претензию/i);
  });
}

test('P-09 receipt with “cards need not be awaited” does not claim cards are still pending', () => {
  const record = processOriginalWithText('П-09', 'Карты получили, количество проверили. Карты ждать не надо')
    .records.find(({ id }) => id === 'П-09');
  const explanation = explanatoryText(record);

  assert.ok(record.priority === 'clear' || record.requiresManualReview === true);
  if (record.priority === 'clear') assert.equal(record.needsAction, false);
  else assert.equal(record.needsAction, true);
  assert.doesNotMatch(explanation, /карты ещ[её] ожидаются|карты пока ожидаются|получение карт не подтверждено/i);
});

test('P-08 “not arriving on time” remains urgent and is either recognized or manually reviewed', () => {
  const record = processOriginalWithText('П-08', 'Вовремя не приеду')
    .records.find(({ id }) => id === 'П-08');
  const explanation = explanatoryText(record);

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  if (record.requiresManualReview) {
    assert.equal(record.needsAction, true);
  } else {
    assert.match(explanation, /задержк|не приеду вовремя|не успею/i);
    assert.doesNotMatch(explanation, /не подтверждает(?:ся)? задержка|задержки нет|задержек нет/i);
  }
});

test('an active S-24 cancellation suffix requires manual review and a focused first action', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-24').messages[0].text;
  const result = processOriginalRecord('С-24', {
    text: `${sourceText}. Увольнение отменено`,
    crm: { status: 'pending', lastDay: '2026-10-19', managerConfirmed: false },
  });
  const record = result.records.find(({ id }) => id === 'С-24');

  assert.equal(record.deadlineReached, true);
  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(record.actions[0], /провер|свер|уточн/i);
  assert.match(record.actions[0], /отмен|увольн|решени|закрыт|смысл/i);
});

test('an active S-17 foreign-documents suffix requires a focused manual check', () => {
  const sourceText = original.data.records.find(({ id }) => id === 'С-17').messages[0].text;
  const record = processOriginalRecord('С-17', {
    text: `${sourceText}. Документы чужие`,
  }).records.find(({ id }) => id === 'С-17');

  assert.equal(record.priority, 'attention');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(record.actions[0], /пров|свер|провер|уточн/i);
  assert.match(record.actions[0], /документ|чуж|принадлеж/i);
});

for (const text of [
  'Это неправда: карты повреждены',
  'Ошибочная информация: карты повреждены',
  'Не пишите: карты повреждены',
  'В сообщении «Карты повреждены» была ошибка',
]) {
  test(`a negated, rejected, or quoted P-09 damage claim is not asserted: ${text}`, () => {
    const record = processOriginalWithText('П-09', text).records.find(({ id }) => id === 'П-09');
    const explanation = explanatoryText(record);

    assert.notEqual(record.priority, 'clear');
    assert.equal(record.needsAction, true);
    assert.equal(record.requiresManualReview, true);
    assert.doesNotMatch(explanation, /есть сообщение о повреждении|сообщается о повреждении|повреждение подтверждено|карты повреждены/i);
    assert.doesNotMatch(record.actions.join(' '), /зафиксировать.*(?:повреж|расхожд)|оформить акт.*(?:повреж|недостач)|предъявить претензию/i);
  });
}

test('a non-late P-08 estimate after 08:00 does not create a delay or deadline-risk claim', () => {
  const record = processP08WithDeadline('Приеду после 08:00', '2026-10-19T12:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, false);
  assert.notEqual(record.priority, 'urgent');
  assert.doesNotMatch(explanation, /срок доставки наступил|сообщил(?:а)? о задержке|сообщается о задержке|риск срыва срока/i);
});

test('an estimate before noon is not converted into a late-delivery claim', () => {
  const record = processP08WithDeadline('Приеду до 12:00', '2026-10-19T12:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, false);
  assert.notEqual(record.priority, 'urgent');
  assert.doesNotMatch(explanation, /срок доставки наступил|сообщил(?:а)? о задержке|сообщается о задержке|риск срыва срока/i);
});

test('an estimate after noon is actionable or manually reviewed without claiming the deadline passed', () => {
  const record = processP08WithDeadline('Приеду после 12:00', '2026-10-19T12:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, false);
  assert.equal(record.needsAction, true);
  assert.ok(record.priority === 'attention' || record.priority === 'review');
  if (record.requiresManualReview) assert.equal(record.needsAction, true);
  else assert.match(explanation, /поздн|срок|окно|доставк/i);
  assert.doesNotMatch(explanation, /срок доставки наступил/i);
});

test('an explicit delay before the deadline remains actionable or honestly reviewed', () => {
  const record = processP08WithDeadline('Задерживаюсь', '2026-10-19T12:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, false);
  assert.equal(record.needsAction, true);
  assert.ok(record.priority === 'attention' || record.priority === 'review');
  if (record.requiresManualReview) assert.equal(record.needsAction, true);
  else assert.match(explanation, /задерж|срок|доставк/i);
  assert.doesNotMatch(explanation, /срок доставки наступил/i);
});

test('conflicting delay statements in one P-08 message require checking the contradiction', () => {
  const record = processP08WithDeadline('Не задерживаюсь. Задерживаюсь', '2026-10-19T10:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.priority, 'urgent');
  assert.equal(record.deadlineReached, true);
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(record.actions[0], /провер|свер|уточн/i);
  assert.match(record.actions[0], /противореч|статус|сообщени|курьер/i);
  assert.doesNotMatch(explanation, /курьер (?:точно )?(?:задерживается|не задерживается)|сообщается о задержке без уточнения/i);
});

test('a denial of delay followed by an unrelated problem is not summarized as a clean denial', () => {
  const record = processP08WithDeadline('Не задерживаюсь. Карты потеряны', '2026-10-19T10:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(explanation, /карт|потер/i, 'the unrelated continuation must remain visible');
  assert.match(record.actions[0], /провер|свер|уточн/i);
});

test('a known delay followed by an unknown route continuation remains urgent and needs review', () => {
  for (const [dueAt, expectedPriority] of [
    ['2026-10-19T10:00:00+03:00', 'urgent'],
    ['2026-10-19T12:00:00+03:00', null],
  ]) {
    const record = processP08WithDeadline('Задерживаюсь. Везу карты на другую точку', dueAt);
    const explanation = explanatoryText(record);

    if (expectedPriority) assert.equal(record.priority, expectedPriority);
    else assert.ok(record.priority === 'attention' || record.priority === 'review');
    assert.equal(record.needsAction, true);
    assert.equal(record.requiresManualReview, true);
    assert.match(explanation, /карт|другую точку|маршрут/i, 'the route continuation must not disappear');
    assert.match(record.actions[0], /провер|свер|уточн/i);
  }
});

test('a P-08 denial plus unknown route continuation remains urgent and manually reviewed', () => {
  const record = processP08WithDeadline('Не задерживаюсь. Везу карты на другую точку', '2026-10-19T10:00:00+03:00');
  const explanation = explanatoryText(record);

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(explanation, /карт|другую точку|маршрут/i);
  assert.doesNotMatch(explanation, /курьер (?:точно )?не задерживается|задержки нет/i);
});

test('a second courier message denying delay creates a manually checked cross-message conflict', () => {
  const data = clone(original.data);
  const p08 = data.records.find(({ id }) => id === 'П-08');
  p08.messages.push({
    id: 'm-08-denial',
    author: 'Курьер',
    text: 'Не задерживаюсь, приеду вовремя',
  });
  const result = processSnapshot(data);
  const record = result.records.find(({ id }) => id === 'П-08');

  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(record.actions[0], /провер|свер|уточн/i);
  assert.match(record.actions[0], /противореч|статус|сообщени|курьер/i);
});

test('clear P-08 delay controls retain the original meaning', () => {
  const originalText = original.data.records.find(({ id }) => id === 'П-08').messages[0].text;
  for (const text of [originalText, 'Задерживаюсь']) {
    const record = processP08WithDeadline(text, '2026-10-19T10:00:00+03:00');

    assert.equal(record.priority, 'urgent');
    assert.equal(record.needsAction, true);
    assert.match(explanatoryText(record), /задерж/i);
  }
});

function processP09ByAuthors(messages) {
  return processSnapshot(oneRecord({
    id: 'П-09',
    crm: { status: 'accepted', acceptedAt: '2026-10-19T09:20:00+03:00' },
    messages,
  })).records[0];
}

for (const author of ['Курьер со слов получателя', 'Представитель банка, не получатель', 'Представитель банка']) {
  test(`P-09 does not treat a compound or negated role as the recipient: ${author}`, () => {
    const text = 'Карты получили, количество проверили';
    const record = processP09ByAuthors([{ id: 'receipt', author, text }]);

    assert.equal(record.priority, 'review');
    assert.equal(record.needsAction, true);
    assert.equal(record.requiresManualReview, true);
    assert.deepEqual(record.chatFacts.map(({ author: outputAuthor, text: outputText }) => [outputAuthor, outputText]), [[author, text]]);
  });
}

for (const author of ['Получатель', 'Кладовщик', 'Сотрудник склада', '  пОЛУЧАТЕЛЬ  ', '  КЛАДОВЩИК ', ' СОтрудник   СКЛАДА ']) {
  test(`P-09 recognizes a direct recipient role alias after case and space normalization: ${author}`, () => {
    const record = processP09ByAuthors([{
      id: 'receipt', author, text: 'Карты получили, количество проверили',
    }]);

    assert.equal(record.priority, 'clear');
    assert.equal(record.needsAction, false);
    assert.equal(record.requiresManualReview, false);
  });
}

test('a courier receipt alone does not confirm recipient acceptance', () => {
  const record = processP09ByAuthors([{
    id: 'receipt', author: 'Курьер', text: 'Карты получили, количество проверили',
  }]);

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
});

test('an unknown participant cannot inherit a recipient confirmation from another message', () => {
  const record = processP09ByAuthors([
    { id: 'recipient', author: 'Получатель', text: 'Карты получили, количество проверили' },
    { id: 'unknown', author: 'Представитель банка', text: 'Карты получили, количество проверили' },
  ]);

  assert.equal(record.priority, 'review');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.deepEqual(record.chatFacts.map(({ author, text }) => [author, text]), [
    ['Получатель', 'Карты получили, количество проверили'],
    ['Представитель банка', 'Карты получили, количество проверили'],
  ]);
});

test('P-08 recipient-authored delay wording does not become a courier report after the deadline', () => {
  const text = 'Задерживаюсь, раньше13:00 не приеду';
  const data = clone(original.data);
  const source = data.records.find(({ id }) => id === 'П-08');
  source.messages[0].author = 'Получатель';
  source.messages[0].text = text;
  const record = processSnapshot(data).records.find(({ id }) => id === 'П-08');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, true);
  assert.equal(record.priority, 'urgent');
  assert.equal(record.needsAction, true);
  assert.equal(record.requiresManualReview, true);
  assert.match(record.actions[0], /уточн|провер|свер/i);
  assert.doesNotMatch(record.actions[0], /курьер/i);
  assert.doesNotMatch(explanation, /курьер сообщи[л|ла] о задержке|курьер задерживается|риск срыва срока/i);
  assert.ok(!record.ruleIds.includes('DELIVERY_DELAY'), 'the recipient text must not be attributed to the courier');
  assert.deepEqual(record.chatFacts.map(({ author, text: outputText }) => [author, outputText]), [['Получатель', text]]);
});

test('P-08 recipient-authored delay wording with a future deadline does not claim courier delay or deadline risk', () => {
  const text = 'Задерживаюсь, раньше13:00 не приеду';
  const data = clone(original.data);
  const source = data.records.find(({ id }) => id === 'П-08');
  source.crm.dueAt = '2026-10-19T15:00:00+03:00';
  source.messages[0].author = 'Получатель';
  source.messages[0].text = text;
  const record = processSnapshot(data).records.find(({ id }) => id === 'П-08');
  const explanation = explanatoryText(record);

  assert.equal(record.deadlineReached, false);
  assert.equal(record.priority, 'review');
  assert.equal(record.requiresManualReview, true);
  assert.equal(record.needsAction, true);
  assert.doesNotMatch(explanation, /курьер сообщи[л|ла] о задержке|курьер задерживается|риск|срыв|срок доставки наступил/i);
  assert.ok(!record.ruleIds.includes('DELIVERY_DELAY_RISK'));
  assert.deepEqual(record.chatFacts.map(({ author, text: outputText }) => [author, outputText]), [['Получатель', text]]);
});



