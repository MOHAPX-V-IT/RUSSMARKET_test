// Условная дата для демо, в задании её нет.
const original = {
  version: 1,
  asOf: '2026-10-19T10:00:00+03:00',
  sources: { crm: 'available', chat: 'available' },
  records: [
    {
      id: 'С-17', type: 'onboarding',
      crm: { status: 'documents_pending', firstDay: '2026-10-20', documentsConfirmed: false },
      messages: [{ id: 'm-17', author: 'Сотрудник', text: 'Вчера отправил фотографии документов руководителю в личку' }],
    },
    {
      id: 'С-24', type: 'offboarding',
      crm: { status: 'pending', lastDay: '2026-10-19', managerConfirmed: false },
      messages: [{ id: 'm-24', author: 'Сотрудник', text: 'С руководителем всё обсудили, он в курсе' }],
    },
    {
      id: 'П-08', type: 'delivery',
      crm: { status: 'in_transit', dueAt: '2026-10-19T10:00:00+03:00', acceptedAt: null },
      messages: [{ id: 'm-08', author: 'Курьер', text: 'Задерживаюсь, раньше 13:00 не приеду' }],
    },
    {
      id: 'П-09', type: 'delivery',
      crm: { status: 'accepted', acceptedAt: '2026-10-19T09:20:00+03:00' },
      messages: [{ id: 'm-09', author: 'Получатель', text: 'Карты получили, количество проверили' }],
    },
  ],
};

const contradiction = structuredClone(original);
contradiction.records.find((record) => record.id === 'П-09').messages.push({
  id: 'm-09-2', author: 'Получатель', text: 'Карты не получили, количество не проверили',
});

const unavailable = structuredClone(original);
unavailable.sources.crm = 'unavailable';

const unknownMessage = structuredClone(original);
unknownMessage.records.find((record) => record.id === 'П-09').messages[0].text = 'Позже напишу подробности';

export const scenarios = [
  { id: 'original', name: 'Исходная ситуация', description: 'Четыре случая из задания на условный понедельник, 10:00 МСК.', data: original },
  { id: 'contradiction', name: 'Противоречие', description: 'По П-09 одновременно сообщают о получении и неполучении карт.', data: contradiction },
  { id: 'source-unavailable', name: 'Источник недоступен', description: 'Данные CRM недоступны: все записи требуют ручной проверки.', data: unavailable },
  { id: 'unknown-message', name: 'Неизвестное сообщение', description: 'По П-09 нет понятного подтверждения получения и сверки.', data: unknownMessage },
];
