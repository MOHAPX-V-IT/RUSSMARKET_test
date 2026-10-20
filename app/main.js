import { scenarios } from '../fixtures/scenarios.js';
import { runVerification } from '../processor/verification.js';

const $ = (id) => document.getElementById(id);
const MAX_BYTES = 1024 * 1024;
const priorities = { urgent: 'Срочно', attention: 'Внимание', review: 'Проверить', clear: 'Без действий' };
const viewNames = { stand: 'Сводка', answer: 'Ответ на тестовое задание', architecture: 'Устройство и проверки' };
let result = null;
let currentData = null;
let filter = 'all';
let generation = 0;
let worker = null;
let requestCounter = 0;
let activeView = 'stand';
let inputText = null;
let inputKind = 'scenario';
let inputBlocked = false;
const pending = new Map();
const reviewed = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function list(values) {
  const node = element('ul');
  for (const value of values ?? []) node.append(element('li', '', value));
  return node;
}

function bytes(text) { return new TextEncoder().encode(text).byteLength; }

function setStatus(text, dirty = false) {
  $('state-message').textContent = text;
  $('state-message').classList.toggle('dirty', dirty);
}

function setBusy(busy) {
  $('run-button').disabled = busy || inputText === null || inputBlocked;
  $('run-button').textContent = busy ? 'Обрабатываю…' : '↗ Сформировать сводку';
  $('records').setAttribute('aria-busy', String(busy));
}

function showError(error, title = 'Ошибка обработки') {
  const box = $('error-message');
  box.replaceChildren(element('h2', '', title));
  if (error.inputError && Array.isArray(error.issues) && error.issues.length) {
    box.append(element('p', '', 'Исправьте поля в JSON и импортируйте файл повторно:'));
    box.append(list(error.issues.map((issue) => {
      const separator = issue.indexOf(':');
      const path = separator < 0 ? 'Корень JSON' : issue.slice(0, separator);
      const detail = separator < 0 ? issue : issue.slice(separator + 1).trim();
      let fix;
      if (/ISO/i.test(detail)) fix = 'укажите дату и время с часовым поясом, например 2026-10-19T10:00:00+03:00.';
      else if (/YYYY-MM-DD/i.test(detail)) fix = 'укажите дату, например 2026-10-20.';
      else if (/boolean/i.test(detail)) fix = 'используйте true или false без кавычек.';
      else if (/дублирующийся идентификатор/i.test(detail)) fix = 'задайте уникальный ID, который не повторяется в этом списке.';
      else if (/массив/i.test(detail)) fix = 'укажите массив [...].';
      else if (/объект/i.test(detail)) fix = /или null/i.test(detail) ? 'укажите объект {...} или null.' : 'укажите объект {...}.';
      else if (/непустая строка/i.test(detail)) fix = 'укажите непустую строку в двойных кавычках.';
      else if (/^ожидается/i.test(detail)) fix = detail.replace(/^ожидается/i, 'укажите');
      else fix = detail;
      return `${path}: ${fix}`;
    })));
  } else {
    box.append(element('p', '', error.message || 'Повторите запуск. Если ошибка сохраняется, выберите другой сценарий или импортируйте исправленный JSON.'));
  }
  box.hidden = false;
}

function jsonError(error, text) {
  const positionMatch = /position\s+(\d+)/i.exec(error.message);
  const lineMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(error.message);
  let place = '';
  if (positionMatch || /unexpected end|unterminated/i.test(error.message)) {
    const position = positionMatch ? Number(positionMatch[1]) : text.length;
    const before = text.slice(0, position);
    const line = before.split('\n').length;
    const column = position - before.lastIndexOf('\n');
    place = ` в строке ${line}, столбце ${column} (позиция ${position + 1})`;
  } else if (lineMatch) {
    place = ` в строке ${lineMatch[1]}, столбце ${lineMatch[2]}`;
  }
  const parsed = new Error(`Некорректный JSON${place}. Проверьте двойные кавычки у ключей и строк, запятые между полями и закрывающие скобки. Исправьте файл и импортируйте его повторно.`);
  parsed.inputError = true;
  return parsed;
}

function emptyState(title, description) {
  const node = element('div', 'empty-state');
  node.append(element('h3', '', title), element('p', '', description));
  return node;
}

function clearResult(message = 'Сформируйте сводку из исходных данных') {
  result = null;
  currentData = null;
  reviewed.clear();
  for (const key of ['total', 'attention', 'urgent', 'clear']) $(`metric-${key}`).textContent = '—';
  $('result-count').textContent = '0';
  $('snapshot-date').textContent = message;
  $('export-json').disabled = true;
  $('export-markdown').disabled = true;
  $('result-warnings').hidden = true;
  $('records').replaceChildren(emptyState('Нужна актуальная сводка', message));
}

function invalidate(message) {
  generation += 1;
  setBusy(false);
  clearResult(message);
  $('error-message').hidden = true;
  setStatus(message, true);
}

function rejectPending(message) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error(message));
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

function getWorker() {
  if (worker) return worker;
  if (location.protocol === 'file:') throw new Error('Откройте стенд через HTTP: выполните npm start и перейдите по адресу локального сервера.');
  if (!('Worker' in window)) throw new Error('Этот браузер не поддерживает Web Worker. Откройте стенд в современном браузере.');
  try {
    worker = new Worker(new URL('../processor/worker.js', import.meta.url), { type: 'module' });
  } catch {
    throw new Error('Не удалось создать Web Worker. Запустите npm start, откройте адрес локального сервера в современном браузере и повторите запуск.');
  }
  worker.addEventListener('message', ({ data }) => {
    const task = pending.get(data.requestId);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(data.requestId);
    if (data.ok) task.resolve(data.result);
    else {
      const error = new Error(data.error?.message || 'Ошибка обработчика.');
      error.issues = data.error?.issues;
      error.inputError = data.error?.message === 'Некорректные входные данные';
      if (!error.inputError) error.message = 'Обработчик завершился с ошибкой. Повторите запуск. Если ошибка сохраняется, проверьте доступность и версию файлов processor/worker.js и processor/engine.js.';
      task.reject(error);
    }
  });
  worker.addEventListener('error', () => rejectPending('Web Worker не удалось запустить. Проверьте, что стенд открыт через HTTP и файлы обработчика доступны.'));
  worker.addEventListener('messageerror', () => rejectPending('Не удалось прочитать ответ Web Worker. Повторите запуск.'));
  return worker;
}

function processInWorker(data) {
  return new Promise((resolve, reject) => {
    try {
      const instance = getWorker();
      const requestId = ++requestCounter;
      const timer = setTimeout(() => rejectPending('Обработка превысила 15 секунд. Сократите входные данные и повторите запуск.'), 15000);
      pending.set(requestId, { resolve, reject, timer });
      instance.postMessage({ requestId, data });
    } catch (error) { reject(error); }
  });
}

function evidenceSection(title, content) {
  const section = element('section', 'evidence-section');
  section.append(element('h4', '', title), content);
  return section;
}

function renderEvidence(record) {
  const details = element('details', 'source-details');
  details.append(element('summary', '', 'Источники и логика вывода'));
  const content = element('div', 'evidence-content');
  content.append(evidenceSection('Факты CRM', record.crmFacts?.length ? list(record.crmFacts) : element('p', 'muted', 'Подтверждённые факты CRM отсутствуют.')));
  const messages = element('div');
  for (const fact of record.chatFacts ?? []) {
    const message = element('div', 'chat-message');
    message.append(element('p', 'message-meta', `${fact.author} · ${fact.messageId}${fact.at ? ` · ${fact.at}` : ''}`), element('blockquote', '', fact.text));
    if (fact.interpretation) message.append(element('p', 'interpretation', fact.interpretation));
    messages.append(message);
  }
  if (!messages.childElementCount) messages.append(element('p', 'muted', 'Нет доступных сообщений.'));
  content.append(evidenceSection('Переписка — исходные сообщения', messages));
  if (record.checks?.length) content.append(evidenceSection('Что проверить', list(record.checks)));
  if (record.actions?.length) content.append(evidenceSection('Следующие действия', list(record.actions)));
  const rules = element('div', 'rule-tags');
  for (const rule of record.ruleIds ?? []) rules.append(element('code', '', rule));
  content.append(evidenceSection('Коды применённых правил', rules));
  if (record.warnings?.length) content.append(evidenceSection('Ограничения и предупреждения', list(record.warnings)));
  details.append(content);
  return details;
}

function renderRecord(record) {
  const card = element('article', 'case-card');
  card.dataset.recordId = record.id;
  card.classList.toggle('reviewed', reviewed.has(record.id));
  const top = element('div', 'case-topline');
  const identity = element('div', 'case-identity');
  identity.append(element('span', 'case-id', record.id), element('h3', 'case-title', record.title));
  const labels = element('div', 'case-labels');
  labels.append(element('span', `priority priority-${record.priority}`, priorities[record.priority] ?? 'Проверить'));
  if (record.priority !== 'review' && record.requiresManualReview) labels.append(element('span', 'manual-review-tag', 'Ручная проверка'));
  top.append(identity, labels);
  card.append(top, element('p', 'case-headline', record.headline));
  const next = element('div', 'next-action');
  next.append(element('span', 'next-action-label', record.needsAction ? 'Следующий шаг' : 'Решение'), element('p', 'next-action-text', record.actions?.[0] || 'Дополнительных действий по доступным данным не требуется.'));
  card.append(next, renderEvidence(record));
  if (record.needsAction) {
    const bottom = element('div', 'case-bottom');
    const label = element('label', 'review-label');
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.checked = reviewed.has(record.id);
    checkbox.setAttribute('aria-label', `Отметить ${record.id} как просмотренное только в этой вкладке`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) reviewed.add(record.id); else reviewed.delete(record.id);
      card.classList.toggle('reviewed', checkbox.checked);
    });
    label.append(checkbox, element('span', '', 'Просмотрено'));
    bottom.append(label);
    card.append(bottom);
  }
  return card;
}

function renderRecords() {
  if (!result) return;
  const visible = result.records.filter((record) => filter === 'all' || (filter === 'review' ? record.requiresManualReview || record.priority === 'review' : record.priority === filter));
  $('result-count').textContent = String(visible.length);
  $('records').replaceChildren(...visible.map(renderRecord));
  if (!visible.length) $('records').append(emptyState(result.records.length ? 'В этой группе нет случаев' : 'Снимок не содержит случаев', result.records.length ? 'Выберите другой фильтр, чтобы увидеть остальные записи.' : 'Чтобы добавить случаи, импортируйте JSON с записями.'));
}

function renderResult(value, data) {
  result = value;
  currentData = data;
  for (const key of ['total', 'attention', 'urgent', 'clear']) $(`metric-${key}`).textContent = String(value.summary[key]);
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value.asOf));
  $('snapshot-date').textContent = `Снимок: ${date} МСК · на ручную проверку: ${value.summary.review}`;
  $('export-json').disabled = false;
  $('export-markdown').disabled = false;
  $('result-warnings').replaceChildren(list(value.warnings));
  $('result-warnings').hidden = !value.warnings?.length;
  renderRecords();
}

async function run() {
  if (inputText === null || inputBlocked) return;
  const ownGeneration = ++generation;
  clearResult('Обработка текущего снимка…');
  $('error-message').hidden = true;
  setStatus('Проверяю данные и применяю правила в Web Worker…');
  setBusy(true);
  try {
    const text = inputText;
    if (bytes(text) > MAX_BYTES) {
      inputText = null;
      const error = new Error('JSON превышает 1 МБ. Сократите число записей и импортируйте файл меньшего размера.');
      error.inputError = true;
      throw error;
    }
    let data;
    try { data = JSON.parse(text); } catch (error) { throw jsonError(error, text); }
    const value = await processInWorker(data);
    if (ownGeneration !== generation) return;
    renderResult(value, data);
    setStatus('Сводка сформирована.');
  } catch (error) {
    if (ownGeneration !== generation) return;
    const invalidInput = Boolean(error.inputError);
    inputBlocked = Boolean(invalidInput);
    clearResult(invalidInput ? 'Исправьте JSON и импортируйте его повторно или выберите сценарий.' : 'Повторите запуск после устранения ошибки.');
    showError(error, inputKind === 'import' && invalidInput ? 'Ошибки импорта' : 'Ошибка обработки');
    setStatus('Обработка не завершена. Актуальной сводки нет.');
  } finally {
    if (ownGeneration === generation) setBusy(false);
  }
}

function selectedScenario() { return scenarios.find((scenario) => scenario.id === $('scenario').value) ?? scenarios[0]; }
function loadScenario(initial = false) {
  const scenario = selectedScenario();
  $('imported-scenario-option')?.remove();
  $('scenario').value = scenario.id;
  inputText = JSON.stringify(structuredClone(scenario.data), null, 2);
  inputKind = 'scenario';
  inputBlocked = false;
  invalidate('Сценарий загружен. Сформируйте сводку для этих данных.');
  $('scenario-description').textContent = scenario.description;
  if (initial) run();
}

function navigate() {
  const requested = location.hash.slice(1);
  if (requested === 'main') {
    $('main').focus({ preventScroll: true });
    $('main').scrollIntoView({ block: 'start' });
    return;
  }
  const active = Object.hasOwn(viewNames, requested) ? requested : 'stand';
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.dataset.view !== active;
  for (const link of document.querySelectorAll('[data-nav]')) {
    if (link.dataset.nav === active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  document.title = `${viewNames[active]} — Support Brief`;
  if (active !== activeView) window.scrollTo(0, 0);
  activeView = active;
}

const escapeMarkdown = (value) => String(value).replace(/[\\`*_{}\[\]<>()!|#]/g, '\\$&');
function markdownExport() {
  const lines = ['# Support Brief', '', `Снимок: ${escapeMarkdown(result.asOf)}`, `Движок: ${escapeMarkdown(result.engine)}. Локальные правила; CRM и LLM не подключены.`, '', `Всего: ${result.summary.total}. Требуют внимания: ${result.summary.attention}. Срочно: ${result.summary.urgent}. Ручная проверка: ${result.summary.review}. Без действий: ${result.summary.clear}.`, ''];
  for (const warning of result.warnings ?? []) lines.push(`Предупреждение: ${escapeMarkdown(warning)}`, '');
  for (const record of result.records) {
    lines.push(`## ${escapeMarkdown(record.id)} · ${escapeMarkdown(record.title)}`, '', `Приоритет: ${priorities[record.priority]}`);
    if (record.requiresManualReview || record.priority === 'review') lines.push('Ручная проверка: требуется.');
    lines.push(escapeMarkdown(record.headline), '', '### Факты CRM');
    for (const fact of record.crmFacts ?? []) lines.push(`- ${escapeMarkdown(fact)}`);
    lines.push('', '### Переписка');
    for (const fact of record.chatFacts ?? []) lines.push(`- ${escapeMarkdown(fact.author)} [${escapeMarkdown(fact.messageId)}]: ${escapeMarkdown(fact.text)}`, `  Интерпретация: ${escapeMarkdown(fact.interpretation ?? '')}`);
    for (const [title, items] of [['Что проверить', record.checks], ['Следующие действия', record.actions], ['Правила', record.ruleIds], ['Предупреждения', record.warnings]]) {
      if (!items?.length) continue;
      lines.push('', `### ${title}`);
      for (const item of items) lines.push(`- ${escapeMarkdown(item)}`);
    }
    lines.push('', `Локальная отметка просмотра: ${reviewed.has(record.id) ? 'просмотрено' : 'нет'}.`, '');
  }
  lines.push('Отметки просмотра действуют только в текущей вкладке. Изменения CRM и отправка сообщений не выполнялись.');
  return lines.join('\n');
}

function download(format) {
  if (!result || !currentData) return;
  const body = format === 'json' ? JSON.stringify({ ...result, localReview: { scope: 'Только текущая вкладка; CRM не изменялась', reviewedRecordIds: [...reviewed] } }, null, 2) : markdownExport();
  const blob = new Blob([body], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `support-brief-${result.asOf.slice(0, 10)}.${format === 'json' ? 'json' : 'md'}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderAnswer() {
  try {
    const original = scenarios.find((scenario) => scenario.id === 'original');
    const answer = await processInWorker(structuredClone(original.data));
    $('answer-cases').replaceChildren(...answer.records.map((record) => {
      const card = element('article', 'panel answer-case');
      card.append(element('span', `priority priority-${record.priority}`, priorities[record.priority]));
      const title = element('h3');
      title.append(element('span', 'case-id', record.id), document.createTextNode(record.title));
      card.append(title, element('p', 'case-headline', record.headline));
      const dl = element('dl');
      const known = [...record.crmFacts, ...record.chatFacts.map((fact) => `${fact.author}: «${fact.text}» (${fact.messageId}).`)].join(' ');
      for (const [term, value] of [['Известно', known], ['Проверить', record.checks.join(' ')], ['Следующий шаг', record.actions.join(' ') || 'Дополнительных действий по доступным данным не требуется.']]) {
        const group = element('div');
        group.append(element('dt', '', term), element('dd', '', value));
        dl.append(group);
      }
      card.append(dl);
      const tags = element('div', 'rule-tags');
      tags.style.marginTop = '16px';
      for (const rule of record.ruleIds) tags.append(element('code', '', rule));
      card.append(tags);
      return card;
    }));
  } catch (error) {
    $('answer-cases').replaceChildren(element('p', 'error-message', `Не удалось сформировать исходные четыре случая: ${error.message}`));
  }
}

function verify() {
  const button = $('verify-button');
  button.disabled = true;
  const container = $('verification-results');
  try {
    const checks = runVerification();
    const passed = checks.filter((check) => check.passed === true).length;
    const summary = `${passed} из ${checks.length} проверок пройдено${passed === checks.length && checks.length ? '.' : '. Есть ошибки — откройте детали ниже.'}`;
    $('answer-verification').textContent = `Встроенные проверки выполнены в этой вкладке: ${summary}`;
    container.replaceChildren(element('p', 'verification-summary', summary));
    for (const check of checks) {
      const row = element('div', `verification-row${check.passed === true ? '' : ' failed'}`);
      const mark = element('span', '', check.passed === true ? '✓' : '×');
      mark.setAttribute('aria-label', check.passed === true ? 'Пройдено' : 'Ошибка');
      const copy = element('div');
      copy.append(element('strong', '', check.name), element('p', '', check.detail || 'Проверка выполнена.'));
      row.append(mark, copy);
      container.append(row);
    }
  } catch (error) {
    container.replaceChildren(element('p', 'error-message', `Проверки не завершены: ${error.message}`));
    $('answer-verification').textContent = 'Встроенные проверки не завершены. Успех не подтверждён.';
  } finally { button.disabled = false; }
}

for (const scenario of scenarios) {
  const option = element('option', '', scenario.name);
  option.value = scenario.id;
  $('scenario').append(option);
}
$('scenario').addEventListener('change', () => loadScenario());
$('run-button').addEventListener('click', run);
$('import-json').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  inputText = null;
  inputKind = 'import';
  inputBlocked = false;
  let importedOption = $('imported-scenario-option');
  if (!importedOption) {
    importedOption = element('option', '', 'Свой файл');
    importedOption.id = 'imported-scenario-option';
    importedOption.value = 'imported-input';
    importedOption.disabled = true;
    $('scenario').append(importedOption);
  }
  $('scenario').value = importedOption.value;
  invalidate('Импорт файла…');
  const ownGeneration = generation;
  $('scenario-description').textContent = `Пользовательские данные из файла «${file.name}».`;
  try {
    if (file.size > MAX_BYTES) throw new Error('Файл превышает 1 МБ. Сократите число записей и импортируйте файл меньшего размера.');
    let text;
    try { text = await file.text(); } catch { throw new Error('Не удалось прочитать файл. Сохраните его как JSON в UTF-8 и импортируйте повторно.'); }
    if (ownGeneration !== generation) return;
    if (bytes(text) > MAX_BYTES) throw new Error('Содержимое файла превышает 1 МБ. Сократите JSON и импортируйте файл меньшего размера.');
    inputText = text;
    await run();
  } catch (error) {
    if (ownGeneration === generation) {
      inputText = null;
      inputBlocked = true;
      clearResult('Импортируйте исправленный JSON или выберите сценарий.');
      showError(error, 'Ошибки импорта');
      setStatus('Файл не импортирован. Актуальная сводка не сформирована.');
      setBusy(false);
    }
  }
});
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const item of document.querySelectorAll('[data-filter]')) {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  }
  renderRecords();
});
$('export-json').addEventListener('click', () => download('json'));
$('export-markdown').addEventListener('click', () => download('markdown'));
$('verify-button').addEventListener('click', verify);
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('main').focus({ preventScroll: true });
  $('main').scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', navigate);
navigate();
loadScenario(true);
renderAnswer();
