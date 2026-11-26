import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import {
  INVALID_INPUT,
  InvalidInputError,
  MODEL_TIMEOUT_MS,
  MAX_TEXT_LENGTH,
  parseRequestBody,
  triage,
} from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MAX_BODY_BYTES = MAX_TEXT_LENGTH * 4 + 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInputError("body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createServer({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.error } = {}) {
  return createHttpServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || path !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = parseRequestBody(await readBody(request));
      const result = await triage(text, { classify, timeoutMs, log });
      return json(response, 200, result);
    } catch (error) {
      if (error instanceof InvalidInputError) return json(response, 400, INVALID_INPUT);
      log(error);
      return json(response, 500, { status: "server_error" });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
