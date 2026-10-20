import { processSnapshot, InputValidationError } from './engine.js';

self.addEventListener('message', (event) => {
  const { requestId, data } = event.data ?? {};
  try {
    self.postMessage({ requestId, ok: true, result: processSnapshot(data) });
  } catch (error) {
    const issues = error instanceof InputValidationError ? error.issues : ['Внутренняя ошибка обработки.'];
    self.postMessage({ requestId, ok: false, error: { message: error instanceof InputValidationError ? error.message : 'Не удалось обработать снимок.', issues } });
  }
});
