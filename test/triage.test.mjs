// Запуск: node --test   (Node.js 20+, без зависимостей)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";
import { triage, validateModelOutput, MANUAL_REVIEW } from "../triage.mjs";
import { classify } from "../mock-ai.mjs";

let server;
let baseUrl;

before(async () => {
  server = createServer({ log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(body, raw = false) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("корректная заявка → ready с темой и черновиком", async () => {
  const { status, body } = await post({ text: "Когда будет доставка заказа?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

test("тема pricing распознаётся", async () => {
  const { body } = await post({ text: "Какая стоимость подписки?" });
  assert.equal(body.topic, "pricing");
});

for (const [name, payload, raw] of [
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   \n\t" }],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["text = null", { text: null }],
  ["тело — массив", [], false],
  ["тело — null", "null", true],
  ["битый JSON", "{text:", true],
  ["пустое тело", "", true],
]) {
  test(`некорректный ввод (${name}) → 400 invalid_input`, async () => {
    const { status, body } = await post(payload, raw);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

for (const tag of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${tag} → 200 manual_review без черновика`, async () => {
    const started = Date.now();
    const { status, body } = await post({ text: `Где доставка? ${tag}` });
    assert.equal(status, 200);
    assert.deepEqual(body, { status: "manual_review", topic: null, draft: null });
    assert.ok(Date.now() - started < 1_000, "ответ не должен ждать модель дольше лимита");
  });
}

test("таймаут срабатывает, даже если модель игнорирует AbortSignal", async () => {
  const hanging = () => new Promise(() => {}); // никогда не завершается
  const started = Date.now();
  const result = await triage("текст", { classify: hanging, timeoutMs: 50 });
  assert.deepEqual(result, MANUAL_REVIEW);
  assert.ok(Date.now() - started < 500);
});

test("модель получает signal и он отменяется по таймауту", async () => {
  let receivedSignal;
  const slow = (text, { signal }) => {
    receivedSignal = signal;
    return classify("[timeout]", { signal });
  };
  await triage("x", { classify: slow, timeoutMs: 30 });
  assert.equal(receivedSignal.aborted, true);
});

test("validateModelOutput отсекает неподходящие ответы", () => {
  assert.equal(validateModelOutput("not json"), null);
  assert.equal(validateModelOutput("null"), null);
  assert.equal(validateModelOutput("[]"), null);
  assert.equal(validateModelOutput(JSON.stringify({ topic: "refund", draft: "ok" })), null);
  assert.equal(validateModelOutput(JSON.stringify({ topic: "other", draft: "  " })), null);
  assert.equal(validateModelOutput(JSON.stringify({ topic: "other", draft: 1 })), null);
  assert.equal(validateModelOutput(JSON.stringify({ topic: "other" })), null);
  assert.deepEqual(validateModelOutput(JSON.stringify({ topic: "other", draft: " Ок " })), { topic: "other", draft: "Ок" });
});

test("лишние поля модели не попадают в ответ API", async () => {
  const leaky = async () => JSON.stringify({ topic: "other", draft: "Ок", secret: "x", status: "hacked" });
  const result = await triage("x", { classify: leaky });
  assert.deepEqual(result, { status: "ready", topic: "other", draft: "Ок" });
});

test("неизвестный маршрут → 404", async () => {
  const response = await fetch(`${baseUrl}/nope`);
  assert.equal(response.status, 404);
});
