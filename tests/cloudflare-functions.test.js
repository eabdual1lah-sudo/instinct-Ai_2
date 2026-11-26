import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/health.js";
import { onRequestPost } from "../functions/api/chat.js";

const secret = "test-only-gemini-secret";
let requestNumber = 0;

function chatRequest(message = "Hello") {
  requestNumber += 1;
  return new Request("https://example.test/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `test-${requestNumber}`
    },
    body: JSON.stringify({ sessionId: `test-session-${requestNumber}`, message })
  });
}

function geminiResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("health reports key presence without exposing the key", async () => {
  const response = await onRequestGet({ env: { GEMINI_API_KEY: secret } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.apiKeyConfigured, true);
  assert.equal(JSON.stringify(payload).includes(secret), false);
});

test("health reports a missing key", async () => {
  const response = await onRequestGet({ env: {} });
  assert.equal((await response.json()).apiKeyConfigured, false);
});

test("chat reports missing key without calling Gemini", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Gemini must not be called"); };
  try {
    const response = await onRequestPost({ request: chatRequest(), env: {} });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /GEMINI_API_KEY/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat sends the runtime secret to Gemini and returns its answer", async () => {
  const originalFetch = globalThis.fetch;
  let sentKey;
  let sentUrl;
  globalThis.fetch = async (url, options) => {
    sentUrl = String(url);
    sentKey = options.headers["x-goog-api-key"];
    return geminiResponse(200, {
      candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }]
    });
  };
  try {
    const response = await onRequestPost({
      request: chatRequest(),
      env: { GEMINI_API_KEY: secret }
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.answer, "Hello from Gemini");
    assert.equal(sentKey, secret);
    assert.match(sentUrl, /models\/gemini-3\.8-flash:generateContent$/);
    assert.equal(JSON.stringify(payload).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat sanitizes Gemini API errors in responses and logs", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged = [];
  globalThis.fetch = async () => geminiResponse(403, {
    error: { status: secret, message: `invalid key ${secret}` }
  });
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await onRequestPost({
      request: chatRequest(),
      env: { GEMINI_API_KEY: secret }
    });
    const payload = await response.text();
    assert.equal(response.status, 502);
    assert.equal(payload.includes(secret), false);
    assert.equal(logged.join(" ").includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("chat reports upstream connection failures without exposing error text", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const logged = [];
  globalThis.fetch = async () => { throw new Error(`connection leaked ${secret}`); };
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const response = await onRequestPost({
      request: chatRequest(),
      env: { GEMINI_API_KEY: secret }
    });
    const payload = await response.text();
    assert.equal(response.status, 502);
    assert.equal(payload.includes(secret), false);
    assert.equal(logged.join(" ").includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});
