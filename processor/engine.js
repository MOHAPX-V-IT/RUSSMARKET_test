// Правила обработки сводки.
export class InputValidationError extends Error {
  constructor(issues) {
    super('Некорректные входные данные');
    this.name = 'InputValidationError';
    this.issues = issues;
  }
}

const ENGINE = 'rules-v2';
const PRIORITY_ORDER = { urgent: 0, attention: 1, review: 2, clear: 3 };
const SOURCE_STATES = new Set(['available', 'unavailable', 'partial']);
const SOURCE_LABELS = { available: 'доступен', unavailable: 'недоступен', partial: 'доступен частично' };
const TYPES = new Set(['onboarding', 'offboarding', 'delivery']);
const TITLES = { onboarding: 'Первый рабочий день', offboarding: 'Последний рабочий день', delivery: 'Поставка карт' };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validIso(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDate(match[1])) return false;
  const [, , hour, minute, second, zone] = match;
  if (+hour > 23 || +minute > 59 || +second > 59) return false;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function validate(data) {
  const issues = [];
  if (!isObject(data)) throw new InputValidationError(['Ожидается объект снимка.']);
  if (data.version !== 1) issues.push('version: ожидается 1.');
  if (!validIso(data.asOf)) issues.push('asOf: требуется действительная дата и время ISO с часовым поясом.');
  if (!isObject(data.sources)) {
    issues.push('sources: требуется объект crm/chat.');
  } else {
    for (const source of ['crm', 'chat']) {
      if (!SOURCE_STATES.has(data.sources[source])) issues.push(`sources.${source}: ожидается available, unavailable или partial.`);
    }
  }
  if (!Array.isArray(data.records)) {
    issues.push('records: требуется массив.');
  } else {
    const recordIds = new Set();
    data.records.forEach((record, index) => {
      const path = `records[${index}]`;
      const messageIds = new Set();
      if (!isObject(record)) { issues.push(`${path}: требуется объект.`); return; }
      if (typeof record.id !== 'string' || !record.id.trim()) issues.push(`${path}.id: требуется непустая строка.`);
      else if (recordIds.has(record.id)) issues.push(`${path}.id: дублирующийся идентификатор ${record.id}.`);
      else recordIds.add(record.id);
      if (typeof record.type !== 'string' || !record.type.trim()) issues.push(`${path}.type: требуется непустая строка.`);
      if (record.crm !== null && !isObject(record.crm)) issues.push(`${path}.crm: требуется объект или null.`);
      if (isObject(record.crm)) {
        const crm = record.crm;
        if (crm.status !== undefined && typeof crm.status !== 'string') issues.push(`${path}.crm.status: требуется строка.`);
        for (const field of ['firstDay', 'lastDay']) {
          if (crm[field] !== undefined && crm[field] !== null && !validDate(crm[field])) issues.push(`${path}.crm.${field}: требуется действительная дата YYYY-MM-DD.`);
        }
        for (const field of ['dueAt', 'acceptedAt']) {
          if (crm[field] !== undefined && crm[field] !== null && !validIso(crm[field])) issues.push(`${path}.crm.${field}: требуется действительная дата и время ISO с часовым поясом.`);
        }
        for (const field of ['documentsConfirmed', 'managerConfirmed']) {
          if (crm[field] !== undefined && typeof crm[field] !== 'boolean') issues.push(`${path}.crm.${field}: требуется boolean.`);
        }
      }
      if (!Array.isArray(record.messages)) {
        issues.push(`${path}.messages: требуется массив.`);
      } else {
        record.messages.forEach((message, messageIndex) => {
          const messagePath = `${path}.messages[${messageIndex}]`;
          if (!isObject(message)) { issues.push(`${messagePath}: требуется объект.`); return; }
          if (typeof message.id !== 'string' || !message.id.trim()) issues.push(`${messagePath}.id: требуется непустая строка.`);
          else if (messageIds.has(message.id)) issues.push(`${messagePath}.id: дублирующийся идентификатор ${message.id}.`);
          else messageIds.add(message.id);
          if (typeof message.author !== 'string' || !message.author.trim()) issues.push(`${messagePath}.author: требуется непустая строка.`);
          if (typeof message.text !== 'string') issues.push(`${messagePath}.text: требуется строка.`);
          if (message.at !== undefined && !validIso(message.at)) issues.push(`${messagePath}.at: требуется действительная дата и время ISO с часовым поясом.`);
        });
      }
    });
  }
  if (issues.length) throw new InputValidationError(issues);
}

function moscowDate(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(date, count) {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day + count);
  return result.toISOString().slice(0, 10);
}

function normalise(text) {
  return text.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function deliveryRole(author) {
  const role = normalise(author);
  if (role === 'курьер') return 'courier';
  if (role === 'получатель' || role === 'кладовщик' || role === 'сотрудник склада') return 'recipient';
  return null;
}

function hasPositiveVerb(text, verbPattern) {
  const pattern = new RegExp(`(?:^|[^а-яa-z])(?:${verbPattern})(?:$|[^а-яa-z])`, 'u');
  const negative = new RegExp(`(?:^|[^а-яa-z])(?:не|никто не|еще не|пока не)\\s+(?:${verbPattern})(?:$|[^а-яa-z])`, 'u');
  return pattern.test(text) && !negative.test(text);
}

function isUncertain(text) {
  return /[?？]|(?:^|[^а-я])если(?:$|[^а-я])|при условии|в случае если|предположим|допустим|возможно|может быть|якобы|вроде|кажется|похоже|говорят|по словам|не подтвержд|сомнева|не уверен/.test(text);
}

function messageSignals(message) {
  const text = normalise(message.text);
  const statement = text.replace(/[.!]+$/g, '').trim();
  const sentences = text.match(/[^.!?？]+[.!?？]?/g) ?? [];
  let uncertain = sentences.some(isUncertain);
  // Вопрос в отдельном предложении не стирает предыдущее утверждение.
  const asserted = sentences.filter((sentence) => !isUncertain(sentence)).join(' ').trim();
  const clauses = asserted.split(/[,;:]|\.(?!\d)/).map((part) => part.trim()).filter(Boolean);
  const claimClauses = asserted.split(/(?<!\d):|:(?!\d)|[,;.!?？]/).map((part) => part.trim()).filter(Boolean);
  const docs = /фото|фотограф|документ/.test(text);
  const sent = hasPositiveVerb(asserted, 'отправил[аи]?|выслал[аи]?|переслал[аи]?');
  const docsInPrivate = docs && sent && /личк|личн(?:ый|ом|ую)|мессенджер/.test(asserted);
  const docsNotSent = docs && /(?:^|[^а-я])(?:не|еще не|пока не)\s+(?:отправил[аи]?|выслал[аи]?|переслал[аи]?)/u.test(text);
  const discussed = /обсудил[аи]?|обговорил[аи]?/.test(asserted) && !/(?:не|еще не|пока не)\s+(?:обсудил[аи]?|обговорил[аи]?)/.test(asserted);
  // Для clear в кадровых кейсах всё сообщение должно входить в понятную грамматику.
  const knownOnboarding = !uncertain && /^(?:я\s+)?(?:(?:вчера|сегодня|ранее)\s+)?(?:отправил[аи]?|выслал[аи]?|переслал[аи]?)\s+(?:(?:фото|фотографии|сканы|копии)\s+)?документ(?:ы|ов)\s+(?:руководителю\s+в\s+(?:личку|личный\s+чат)|в\s+(?:личку|личный\s+чат)\s+руководителю)$/.test(statement);
  const knownOffboarding = !uncertain && /^(?:я\s+|мы\s+)?(?:с\s+руководителем\s+)?(?:все\s+)?(?:обсудил[аи]?|обговорил[аи]?)(?:\s+с\s+руководителем)?(?:,\s*(?:он|руководитель)\s+в\s+курсе)?$/.test(statement);
  const cardReceipt = /^(?:все\s+)?(?:карты|поставку)\s+(?:получил[аи]?|принял[аи]?)$|^(?:получил[аи]?|принял[аи]?)\s+(?:все\s+)?(?:карты|поставку)$/;
  const quantity = /^(?:количество(?:\s+карт)?|число\s+карт)\s+(?:проверил[аи]?|сверил[аи]?)$|^(?:проверил[аи]?|сверил[аи]?)\s+количество(?:\s+карт)?$/;
  const noDiscrepancyClause = /^(?:нет\s+(?:расхожд[а-я]*|недостач[а-я]*|поврежден[а-я]*)|(?:расхожд[а-я]*|недостач[а-я]*|поврежден[а-я]*)\s+нет|без\s+(?:расхожд[а-я]*|недостач[а-я]*|поврежден[а-я]*))$/;
  // Вводная до двоеточия должна сама быть понятным фактом.
  const colonParts = asserted.split(/(?<!\d):|:(?!\d)/);
  const introductoryClauses = colonParts[0].split(/[,;.!?？]/).map((part) => part.trim()).filter(Boolean);
  const colonContextUnknown = colonParts.length > 1 && (colonParts.length !== 2
    || introductoryClauses.length === 0
    || !introductoryClauses.every((clause) => cardReceipt.test(clause) || quantity.test(clause) || noDiscrepancyClause.test(clause)));
  uncertain ||= colonContextUnknown;
  const deliveryClauses = colonContextUnknown ? [] : clauses;
  const deliveryClaimClauses = colonContextUnknown ? [] : claimClauses;
  const receiptClauses = deliveryClauses.filter((clause) => cardReceipt.test(clause));
  const quantityClauses = deliveryClauses.filter((clause) => quantity.test(clause));
  const received = receiptClauses.length > 0;
  const quantityChecked = quantityClauses.length > 0;
  const knownDelivery = !uncertain && deliveryClauses.length > 0 && deliveryClauses.every((clause) => cardReceipt.test(clause) || quantity.test(clause) || noDiscrepancyClause.test(clause));
  const notReceived = deliveryClaimClauses.some((clause) => /^(?:карты\s+(?:пока\s+|еще\s+)?не\s+(?:получил[аи]?|принял[аи]?)|(?:пока\s+|еще\s+)?не\s+(?:получил[аи]?|принял[аи]?)\s+карты)$/.test(clause));
  const awaitingCards = deliveryClaimClauses.some((clause) => /^(?:карты\s+(?:(?:пока|еще)\s+)?ждем|(?:(?:пока|еще)\s+)?ждем\s+карты)$/.test(clause));
  // Положительный факт допускается только по целому понятному фрагменту.
  const discrepancyPattern = /^(?:не\s+хватает\s+(?:(?:\d+|[а-я]+)\s+)?карт|(?:карты|поставку)\s+(?:получил[аи]?|принял[аи]?)\s+не\s+все|часть(?:\s+карт)?\s+отсутствует|упаковка\s+(?:вскрыта|повреждена)|номера(?:\s+карт)?\s+не\s+совпадают|есть\s+(?:расхождения|несоответствия)|(?:обнаружена|подтверждена)\s+недостача|карты\s+повреждены)$/;
  const discrepancy = deliveryClaimClauses.some((clause) => discrepancyPattern.test(clause.replace(/^(?:но|однако)\s+/, '')));
  const noDelayPattern = /^(?:не\s+(?:задерживаюсь|задержусь|опаздываю|опоздаю)|(?:нет\s+задержек|задержек\s+нет|без\s+задержек)|приеду\s+вовремя)$/;
  const unconfirmedDelay = /(?:задерж[а-я]*\s+не\s+(?:подтвержд|выявлен|обнаружен)[а-я]*|не\s+(?:могу|удалось)\s+подтверд[а-я]*\s+задерж[а-я]*)/.test(text);
  const noDelay = deliveryClaimClauses.some((clause) => noDelayPattern.test(clause));
  const reportedNotBeforePattern = /^(?:раньше\s+\d{1,2}(?::\d{2})?\s+не\s+приеду|не\s+успею\s+к\s+\d{1,2}(?::\d{2})?|приеду\s+после\s+\d{1,2}(?::\d{2})?|после\s+\d{1,2}(?::\d{2})?\s+приеду)$/;
  const reportedNotBefore = deliveryClaimClauses.some((clause) => reportedNotBeforePattern.test(clause));
  const delayPattern = /^(?:я\s+|мы\s+)?(?:задерживаюсь|задерживаемся|задержусь|опаздываю|опоздаю)$|^задержка\s+(?:подтверждена|ожидается)$/;
  const delay = deliveryClaimClauses.some((clause) => delayPattern.test(clause));
  const unknownTransitClauses = deliveryClaimClauses.filter((clause) => !delayPattern.test(clause) && !noDelayPattern.test(clause) && !reportedNotBeforePattern.test(clause));
  const knownTransitContext = !uncertain && deliveryClaimClauses.length > 0 && unknownTransitClauses.length === 0;
  return { uncertain, colonContextUnknown, docsInPrivate, docsNotSent, discussed, knownOnboarding, knownOffboarding, notReceived, awaitingCards, received, quantityChecked, knownDelivery, knownTransitContext, unknownTransitClauses, discrepancy, noDelay, unconfirmedDelay, reportedNotBefore, delay };
}

function explainSignal(signal) {
  const unknownTransitText = signal.unknownTransitClauses.length
    ? ` Нераспознанный фрагмент: «${signal.unknownTransitClauses.join('; ')}».`
    : '';
  if (signal.colonContextUnknown) return 'Вводная часть не подтверждает фразу после двоеточия; нужен просмотр исходного сообщения.';
  if (signal.discrepancy) return 'Сообщается о возможном расхождении поставки; требуется сверка с получателем и первичными документами.';
  if (signal.awaitingCards) return 'Получение документов или проверка количества не подтверждает передачу карт; карты ещё ожидаются.';
  if (signal.delay && signal.noDelay) return 'В сообщении противоречивые утверждения о задержке; требуется сверка у курьера.';
  if (signal.unconfirmedDelay) return 'Задержка в сообщении не подтверждена; фактический статус нужно уточнить.';
  if (signal.delay && !signal.knownTransitContext) return `Заявлена задержка, но остальная часть сообщения не распознана; нужен просмотр всего контекста.${unknownTransitText}`;
  if (signal.uncertain) return 'Вопрос, условие или предположение не подтверждает факт; требуется ручная проверка.';
  if (signal.docsNotSent) return 'Сотрудник сообщает, что документы не отправлены; подтверждения загрузки в CRM нет.';
  if (signal.docsInPrivate) return signal.knownOnboarding
    ? 'Сообщается об отправке фото в личном канале; загрузка в CRM этим не подтверждена.'
    : 'Есть сообщение об отправке фото, но весь текст не распознан; нужен просмотр исходного сообщения.';
  if (signal.discussed) return signal.knownOffboarding
    ? 'Сотрудник сообщает об обсуждении; подтверждение руководителя этим не заменяется.'
    : 'Есть сообщение об обсуждении, но весь текст не распознан; нужен просмотр исходного сообщения.';
  if (signal.notReceived) return 'Сообщается, что получение не состоялось.';
  if (signal.received && signal.quantityChecked && signal.knownDelivery) return 'Сообщается о получении поставки и сверке количества.';
  if (signal.received) return 'Сообщается о получении поставки; полный контекст приёмки не подтверждён.';
  if (signal.delay) return 'Сообщается о задержке; точное время прибытия не подтверждено.';
  if (signal.reportedNotBefore) return 'Указана только нижняя граница времени прибытия без даты; окно доставки нужно уточнить.';
  if (signal.noDelay && !signal.knownTransitContext) return `Заявлено отсутствие задержки, но остальная часть сообщения не распознана; нужен просмотр всего контекста.${unknownTransitText}`;
  if (signal.noDelay) return 'Сообщение не подтверждает задержку; статус приёмки проверяется отдельно.';
  return 'Однозначный сигнал по ограниченным правилам не найден; нужна ручная проверка.';
}

function makeBase(record) {
  const signals = record.messages.map(messageSignals);
  return {
    id: record.id, type: record.type, title: TITLES[record.type] ?? 'Неизвестный тип обращения',
    priority: 'review', needsAction: true, requiresManualReview: false, deadlineReached: false, headline: '',
    crmFacts: [],
    chatFacts: record.messages.map((message, index) => ({
      messageId: message.id, author: message.author, text: message.text,
      interpretation: explainSignal(signals[index]),
      ...(message.at === undefined ? {} : { at: message.at }),
    })),
    checks: [], actions: [], ruleIds: [], warnings: [],
  };
}

function review(item, headline, warning, ruleId) {
  item.priority = item.deadlineReached ? 'urgent' : 'review';
  item.needsAction = true;
  item.requiresManualReview = true;
  item.headline = item.deadlineReached ? `${headline}; срок уже наступил` : headline;
  if (warning) item.warnings.push(warning);
  item.checks.push('Сверить исходные данные с ответственным и первичной системой.');
  item.actions.push('Провести ручную проверку до изменения статуса или отправки сообщения.');
  if (item.deadlineReached) item.actions.push('Проверить ситуацию сегодня у ответственного из-за наступившего срока.');
  item.ruleIds.push(ruleId);
  return item;
}

function requireTransitContextReview(item) {
  item.requiresManualReview = true;
  item.checks.unshift('Сверить весь контекст переписки, состояние карт и фактический статус поставки.');
  item.actions.unshift('Уточнить у курьера весь контекст сообщения и состояние карт.');
  item.ruleIds.push('DELIVERY_CONTEXT_REVIEW');
}

function classify(record, data, today) {
  const item = makeBase(record);
  const crm = record.crm;
  const signals = record.messages.map(messageSignals);
  item.deadlineReached = crm !== null && (
    (record.type === 'onboarding' && typeof crm.firstDay === 'string' && crm.firstDay <= today)
    || (record.type === 'offboarding' && typeof crm.lastDay === 'string' && crm.lastDay <= today)
    || (record.type === 'delivery' && crm.status === 'in_transit' && typeof crm.dueAt === 'string' && Date.parse(crm.dueAt) <= Date.parse(data.asOf))
  );
  if (crm !== null) {
    const labels = { status: 'Статус CRM', firstDay: 'Первый день', lastDay: 'Последний день', documentsConfirmed: 'Документы подтверждены', managerConfirmed: 'Руководитель подтвердил', dueAt: 'Срок доставки', acceptedAt: 'Время приёмки' };
    const statuses = { documents_pending: 'документы ожидаются', ready: 'готово', pending: 'ожидает подтверждения', confirmed: 'подтверждено', in_transit: 'в пути', accepted: 'принято' };
    for (const [key, value] of Object.entries(crm)) {
      if (value !== null && value !== undefined) {
        const displayed = typeof value === 'boolean' ? (value ? 'да' : 'нет') : key === 'status' ? (statuses[value] ?? value) : value;
        item.crmFacts.push(`${labels[key] ?? key}: ${displayed}`);
      }
    }
  }
  if (!TYPES.has(record.type)) return review(item, 'Неизвестный тип записи', 'Для этого типа правила не заданы.', 'UNKNOWN_TYPE');
  if (record.messages.some((message) => message.at && Date.parse(message.at) > Date.parse(data.asOf))) {
    return review(item, 'Сообщение датировано позже момента снимка', 'Будущее сообщение не может быть фактом текущей сводки.', 'FUTURE_MESSAGE');
  }
  if (data.sources.crm !== 'available' || data.sources.chat !== 'available' || crm === null) {
    const unavailable = [data.sources.crm !== 'available' ? `CRM: ${SOURCE_LABELS[data.sources.crm]}` : null,
      data.sources.chat !== 'available' ? `чат: ${SOURCE_LABELS[data.sources.chat]}` : null, crm === null ? 'CRM-запись отсутствует' : null].filter(Boolean).join('; ');
    return review(item, 'Неполные или недоступные источники', unavailable, 'SOURCE_INCOMPLETE');
  }
  if (record.messages.length === 0) {
    return review(item, 'Нет сообщений для сопоставления с CRM', 'Источник чата доступен, но сообщений по записи нет.', 'CHAT_EVIDENCE_MISSING');
  }
  if (record.type === 'delivery') {
    const roleIssues = record.messages.map((message, index) => {
      const role = deliveryRole(message.author);
      const signal = signals[index];
      const courierClaim = signal.delay || signal.noDelay || signal.reportedNotBefore || signal.unconfirmedDelay;
      const recipientClaim = signal.received || signal.quantityChecked || signal.notReceived || signal.awaitingCards || signal.discrepancy;
      return role === null || (role === 'courier' && recipientClaim) || (role === 'recipient' && courierClaim);
    });
    if (roleIssues.some(Boolean)) {
      // Неподходящий автор не даёт прямого факта о приёмке или движении.
      roleIssues.forEach((issue, index) => {
        if (issue) item.chatFacts[index].interpretation = 'Слова сообщения нельзя принять как прямое подтверждение этой роли; нужно сверить автора и отношение к поставке.';
      });
      review(item, 'Автор сообщения о поставке требует уточнения', 'Роль автора не подтверждает прямой вывод о статусе поставки.', 'DELIVERY_AUTHOR_REVIEW');
      item.checks.unshift('Сверить фактического автора каждого сообщения и его отношение к этой поставке.');
      item.actions.unshift('Уточнить автора, его роль и отношение сообщения к поставке до выводов о статусе.');
      return item;
    }
  }
  if (record.type === 'delivery' && signals.some((signal) => signal.uncertain)
    && !(crm.status === 'in_transit' && (item.deadlineReached || signals.some((signal) => signal.delay)))) {
    return review(item, 'Сообщение не содержит однозначного утверждения', 'Вопрос, условие или предположение не используется как подтверждение факта.', 'CHAT_UNCERTAIN');
  }
  if (record.type === 'onboarding') {
    if (!['documents_pending', 'ready'].includes(crm.status) || !crm.firstDay || typeof crm.documentsConfirmed !== 'boolean') {
      return review(item, 'Состояние выхода или документов неизвестно', 'Не хватает ожидаемых полей CRM либо статус неизвестен.', 'ONBOARDING_UNKNOWN');
    }
    const privateSent = signals.some((signal) => signal.docsInPrivate);
    const notSent = signals.some((signal) => signal.docsNotSent);
    if (privateSent && notSent) return review(item, 'Противоречивые сообщения об отправке документов', 'Сообщения утверждают и отправку, и отсутствие отправки.', 'DOCUMENTS_CONFLICT');
    if (crm.status === 'ready' && !crm.documentsConfirmed) return review(item, 'CRM противоречит подтверждению документов', 'Статус ready при documentsConfirmed=false.', 'CRM_CONFLICT');
    if (crm.status === 'documents_pending' && crm.documentsConfirmed) return review(item, 'CRM противоречит подтверждению документов', 'Статус documents_pending при documentsConfirmed=true.', 'CRM_CONFLICT');
    const tomorrow = addDays(today, 1);
    if (crm.firstDay <= tomorrow && !crm.documentsConfirmed) {
      item.priority = crm.firstDay <= today ? 'urgent' : 'attention';
      item.needsAction = true;
      item.headline = crm.firstDay <= today ? 'Выход уже наступил, документы не подтверждены в CRM' : 'Первый выход завтра, документы не подтверждены в CRM';
      item.checks.push('Проверить документы и статус подтверждения в CRM у ответственного.');
      item.actions.push('Попросить загрузить документы в установленный канал и получить подтверждение до выхода.');
      item.ruleIds.push(privateSent ? 'ONBOARDING_PRIVATE_CHANNEL' : 'ONBOARDING_DOCUMENTS_PENDING');
      if (privateSent) item.warnings.push('Фото в личной переписке не подтверждают наличие документов в CRM.');
      if (!signals.every((signal) => signal.knownOnboarding)) {
        item.requiresManualReview = true;
        item.checks.unshift('Проверить актуальность выхода и принадлежность документов по всей переписке.');
        item.actions.unshift('Уточнить у сотрудника и ответственного актуальный план выхода и документы до первого дня.');
        item.ruleIds.push('ONBOARDING_CONTEXT_REVIEW');
      }
      return item;
    }
    if (crm.status === 'ready' && crm.documentsConfirmed) {
      if (notSent || !privateSent || !signals.every((signal) => signal.knownOnboarding)) return review(item, 'CRM подтверждает документы, но сообщение не даёт надёжного контекста', 'Уточнить расхождение либо смысл всей переписки.', 'ONBOARDING_CHAT_REVIEW');
      item.priority = 'clear'; item.needsAction = false;
      item.headline = 'Документы подтверждены в CRM';
      item.checks.push('Подтверждение документов зафиксировано в CRM.');
      item.ruleIds.push('ONBOARDING_READY');
      return item;
    }
    return review(item, 'Недостаточно данных о готовности к выходу', 'Текущий срок или статус не даёт однозначного вывода.', 'ONBOARDING_REVIEW');
  }
  if (record.type === 'offboarding') {
    if (!['pending', 'confirmed'].includes(crm.status) || !crm.lastDay || typeof crm.managerConfirmed !== 'boolean') {
      return review(item, 'Состояние закрытия неизвестно', 'Не хватает ожидаемых полей CRM либо статус неизвестен.', 'OFFBOARDING_UNKNOWN');
    }
    if ((crm.status === 'confirmed') !== crm.managerConfirmed) return review(item, 'Противоречивый статус подтверждения в CRM', 'Статус и managerConfirmed расходятся.', 'CRM_CONFLICT');
    if (crm.lastDay <= today && !crm.managerConfirmed) {
      item.priority = 'urgent'; item.needsAction = true;
      item.headline = 'Последний день наступил, подтверждения руководителя нет';
      item.checks.push('Уточнить у руководителя закрытие всех обязательных пунктов.');
      item.actions.push('Получить явное подтверждение руководителя и зафиксировать его в CRM.');
      item.ruleIds.push('OFFBOARDING_CONFIRMATION_MISSING');
      if (signals.some((signal) => signal.discussed)) item.warnings.push('Сообщение сотрудника об обсуждении не является подтверждением руководителя.');
      if (!signals.every((signal) => signal.knownOffboarding)) {
        item.requiresManualReview = true;
        item.checks.unshift('Проверить по всей переписке, остаётся ли увольнение актуальным.');
        item.actions.unshift('Уточнить у HR и руководителя актуальность увольнения до завершения процесса.');
        item.ruleIds.push('OFFBOARDING_CONTEXT_REVIEW');
      }
      return item;
    }
    if (crm.managerConfirmed) {
      if (!signals.some((signal) => signal.discussed) || !signals.every((signal) => signal.knownOffboarding)) return review(item, 'CRM подтверждает закрытие, но сообщение неясно', 'Нужно сопоставить подтверждение со всей перепиской.', 'OFFBOARDING_CHAT_REVIEW');
      item.priority = 'clear'; item.needsAction = false;
      item.headline = 'Подтверждение руководителя есть в CRM';
      item.checks.push('Подтверждение руководителя зафиксировано в CRM.');
      item.ruleIds.push('OFFBOARDING_CONFIRMED');
      return item;
    }
    return review(item, 'Срок закрытия ещё не наступил, подтверждения нет', 'Нужно уточнить процесс и срок получения подтверждения.', 'OFFBOARDING_REVIEW');
  }
  if (!['in_transit', 'accepted'].includes(crm.status) || (crm.status === 'in_transit' && !crm.dueAt) || (crm.acceptedAt !== null && crm.acceptedAt !== undefined && !validIso(crm.acceptedAt))) {
    return review(item, 'Состояние поставки неизвестно', 'Не хватает ожидаемых полей CRM либо статус неизвестен.', 'DELIVERY_UNKNOWN');
  }
  const received = signals.some((signal) => signal.received);
  const notReceived = signals.some((signal) => signal.notReceived);
  const recipientConfirmed = signals.some((signal, index) => signal.received && signal.quantityChecked && signal.knownDelivery
    && deliveryRole(record.messages[index].author) === 'recipient');
  const delay = signals.some((signal) => signal.delay);
  const discrepancy = signals.some((signal) => signal.discrepancy);
  const awaitingCards = signals.some((signal) => signal.awaitingCards);
  if (delay && signals.some((signal) => signal.noDelay)) {
    review(item, 'Сообщения о задержке противоречат друг другу', 'Нельзя выбрать статус задержки без сверки у курьера.', 'DELIVERY_DELAY_CONFLICT');
    item.checks.unshift('Сверить противоречивые сообщения курьера о задержке.');
    item.actions.unshift('Уточнить у курьера, есть ли задержка и какое сейчас окно доставки.');
    return item;
  }
  if (discrepancy) {
    review(item, 'Есть сообщение о расхождении при поставке', 'Приёмка в CRM не закрывает заявленное расхождение.', 'DELIVERY_DISCREPANCY');
    item.checks.push('Сверить фактическое количество, состояние упаковки и номера карт с накладной и записью CRM.');
    item.actions.unshift('Зафиксировать расхождение и согласовать исправление с ответственным за поставку.');
    return item;
  }
  if (awaitingCards) {
    review(item, crm.status === 'accepted' ? 'Карты ещё ожидаются при статусе «принято» в CRM' : 'Карты ещё ожидаются, приёмка не подтверждена', 'Получение документов не подтверждает получение карт.', 'DELIVERY_CARDS_PENDING');
    item.checks.push('Уточнить у получателя, переданы ли сами карты и сколько их получено.');
    item.actions.unshift('Сверить статус CRM с фактической передачей карт и исправить расхождение после подтверждения.');
    return item;
  }
  if (received && notReceived) return review(item, 'Противоречивые сообщения о получении', 'Сообщения одновременно подтверждают и отрицают получение.', 'DELIVERY_CONFLICT');
  if (crm.status === 'in_transit' && (received || crm.acceptedAt)) return review(item, 'CRM и сообщения о приёмке расходятся', 'В CRM ещё «в пути», но есть признак приёмки.', 'DELIVERY_CONFLICT');
  if (crm.status === 'accepted' && (!crm.acceptedAt || notReceived || delay || Date.parse(crm.acceptedAt) > Date.parse(data.asOf))) {
    return review(item, 'Данные о приёмке противоречивы или неполны', 'Проверить время и фактическое получение у адресата.', 'DELIVERY_CONFLICT');
  }
  if (crm.status === 'in_transit' && signals.some((signal) => signal.reportedNotBefore) && !delay) {
    review(item, 'Окно прибытия по сообщению требует уточнения', 'Время без даты не доказывает срыв срока CRM.', 'DELIVERY_WINDOW_REVIEW');
    item.checks.push('Сопоставить дату и точное окно прибытия со сроком в CRM.');
    item.actions.unshift('Уточнить у курьера дату и полное окно прибытия, затем сверить его со сроком.');
    return item;
  }
  if (crm.status === 'in_transit' && Date.parse(crm.dueAt) <= Date.parse(data.asOf)) {
    if (!delay && !signals.some((signal) => signal.noDelay)) {
      return review(item, 'Срок доставки наступил, сообщение не даёт надёжного статуса', 'Приёмка не подтверждена; содержание сообщения требует проверки.', 'DELIVERY_DUE_REVIEW');
    }
    item.priority = 'urgent'; item.needsAction = true;
    item.headline = delay ? 'Срок доставки наступил, курьер сообщил о задержке' : 'Срок доставки наступил, приёмка не подтверждена';
    item.checks.push('Сверить текущий статус у курьера и получателя; проверить срок в CRM.');
    item.actions.push('Согласовать реалистичное новое окно доставки и предупредить ответственного.');
    if (!signals.every((signal) => signal.knownTransitContext)) requireTransitContextReview(item);
    item.ruleIds.push(delay ? 'DELIVERY_DELAY' : 'DELIVERY_DUE_UNCONFIRMED');
    return item;
  }
  if (crm.status === 'accepted' && recipientConfirmed && signals.every((signal) => signal.knownDelivery)) {
    item.priority = 'clear'; item.needsAction = false;
    item.headline = 'Приёмка подтверждена в CRM и сообщении получателя';
    item.checks.push('Сверить запись о приёмке и количество с первичными документами при штатной проверке.');
    item.ruleIds.push('DELIVERY_ACCEPTED_VERIFIED');
    return item;
  }
  if (crm.status === 'in_transit' && delay) {
    item.priority = 'attention'; item.needsAction = true;
    item.headline = 'Курьер сообщил о возможной задержке до срока';
    item.checks.push('Уточнить фактическое окно доставки у курьера.');
    item.actions.push('Предупредить ответственного о риске срыва срока.');
    if (!signals.every((signal) => signal.knownTransitContext)) requireTransitContextReview(item);
    item.ruleIds.push('DELIVERY_DELAY_RISK');
    return item;
  }
  return review(item, 'Недостаточно подтверждений для вывода о поставке', 'Статус и сообщения не подтверждают завершение процесса.', 'DELIVERY_REVIEW');
}

export function processSnapshot(data) {
  validate(data);
  const today = moscowDate(data.asOf);
  const records = data.records.map((record, index) => ({ item: classify(record, data, today), index }))
    .sort((a, b) => PRIORITY_ORDER[a.item.priority] - PRIORITY_ORDER[b.item.priority]
      || (a.item.type === 'delivery' ? -1 : a.item.type === 'offboarding' ? 0 : 1)
      - (b.item.type === 'delivery' ? -1 : b.item.type === 'offboarding' ? 0 : 1)
      || a.index - b.index)
    .map(({ item }) => item);
  const summary = {
    total: records.length,
    attention: records.filter((record) => record.needsAction).length,
    urgent: records.filter((record) => record.priority === 'urgent').length,
    review: records.filter((record) => record.requiresManualReview).length,
    clear: records.filter((record) => record.priority === 'clear').length,
  };
  const warnings = [];
  if (data.sources.crm !== 'available') warnings.push(`Источник CRM ${SOURCE_LABELS[data.sources.crm]}.`);
  if (data.sources.chat !== 'available') warnings.push(`Источник чата ${SOURCE_LABELS[data.sources.chat]}.`);
  return { version: 1, engine: ENGINE, asOf: data.asOf, summary, warnings, records };
}
