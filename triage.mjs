// Бизнес-логика разбора заявки: проверка ввода, вызов модели с таймаутом,
// строгая проверка ответа модели. Не зависит от HTTP — удобно тестировать.

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;
export const MAX_TEXT_LENGTH = 10_000;

export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });
export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });

export class InvalidInputError extends Error {}

/** Разбирает тело запроса. Бросает InvalidInputError, если ввод не подходит. */
export function parseRequestBody(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new InvalidInputError("body is not valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new InvalidInputError("body must be a JSON object");
  }
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") {
    throw new InvalidInputError("text must be a non-empty string");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new InvalidInputError("text is too long");
  }
  return text;
}

/**
 * Проверяет сырой ответ модели. Возвращает {topic, draft} или null,
 * если ответ нельзя показывать менеджеру как готовый.
 */
export function validateModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { topic, draft } = parsed;
  if (typeof topic !== "string" || !TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

/** Вызывает модель не дольше timeoutMs. Любой сбой → manual_review. */
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS, log = () => {} }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    // Promise.race гарантирует лимит, даже если модель игнорирует signal.
    const raw = await Promise.race([classify(text, { signal: controller.signal }), timeout]);
    const result = validateModelOutput(raw);
    if (!result) {
      log("model returned unusable output");
      return MANUAL_REVIEW;
    }
    return { status: "ready", ...result };
  } catch (error) {
    log(`model failed: ${error?.message ?? error}`);
    return MANUAL_REVIEW;
  } finally {
    clearTimeout(timer);
  }
}
