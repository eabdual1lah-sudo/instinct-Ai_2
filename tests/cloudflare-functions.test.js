import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/health.js";
import { onRequestPost } from "../functions/api/chat.js";

const secret = "test-only-gemini-secret";
const conversationId = "123e4567-e89b-42d3-a456-426614174000";
let requestNumber = 0;
function chatRequest(message = "Hello", authenticated = true) {
  requestNumber += 1;
  return new Request("https://example.test/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `test-${requestNumber}`,
      ...(authenticated ? { Authorization: "Bearer test-access-token" } : {})
    },
    body: JSON.stringify({
      conversationId, message,
      history: [{ role: "user", content: message }]
    })
  });
}
function response(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
function mockAuthenticatedFetch(gemini) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return response(200, { id: "user-test" });
    if (target.includes("/rest/v1/conversations?")) return response(200, [{ id: conversationId }]);
    return gemini(target, options);
  };
}

test("health reports key presence without exposing the key", async () => {
  const r = await onRequestGet({ env: { GEMINI_API_KEY: secret } });
  const payload = await r.json();
  assert.equal(r.status, 200);
  assert.equal(payload.apiKeyConfigured, true);
  assert.equal(JSON.stringify(payload).includes(secret), false);
});
test("health reports a missing key", async () => {
  const r = await onRequestGet({ env: {} });
  assert.equal((await r.json()).apiKeyConfigured, false);
});
test("chat reports missing GEMINI_API_KEY without making network calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network must not be called"); };
  try {
    const r = await onRequestPost({ request: chatRequest(), env: {} });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /GEMINI_API_KEY/);
  } finally { globalThis.fetch = original; }
});
test("chat requires an authenticated user", async () => {
  const r = await onRequestPost({ request: chatRequest("Hello", false), env: { GEMINI_API_KEY: secret } });
  assert.equal(r.status, 401);
});
test("chat verifies ownership, sends runtime secret to Gemini, and returns answer", async () => {
  const original = globalThis.fetch; let sentKey, sentUrl;
  globalThis.fetch = mockAuthenticatedFetch(async (url, options) => {
    sentUrl = url; sentKey = options.headers["x-goog-api-key"];
    return response(200, { candidates: [{ content: { parts: [{ text: "Hello from Gemini" }] } }] });
  });
  try {
    const r = await onRequestPost({ request: chatRequest(), env: { GEMINI_API_KEY: secret, GEMINI_MODEL: "stale-model" } });
    const payload = await r.json();
    assert.equal(r.status, 200); assert.equal(payload.answer, "Hello from Gemini");
    assert.equal(sentKey, secret); assert.match(sentUrl, /models\/gemini-3\.5-flash-lite:generateContent$/);
    assert.equal(JSON.stringify(payload).includes(secret), false);
  } finally { globalThis.fetch = original; }
});
test("chat rejects a conversation not owned by the authenticated user", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith("/auth/v1/user")
    ? response(200, { id: "user-test" }) : response(200, []);
  try {
    const r = await onRequestPost({ request: chatRequest(), env: { GEMINI_API_KEY: secret } });
    assert.equal(r.status, 404);
  } finally { globalThis.fetch = original; }
});
test("health reports the pinned Pages model instead of a stale runtime override", async () => {
  const r = await onRequestGet({ env: { GEMINI_MODEL: "stale-model" } });
  assert.equal((await r.json()).model, "gemini-3.5-flash-lite");
});
test("chat sanitizes Gemini API errors in responses and logs", async () => {
  const original = globalThis.fetch, oldError = console.error, logs = [];
  globalThis.fetch = mockAuthenticatedFetch(async () => response(403, { error: { status: secret, message: "invalid key " + secret } }));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const r = await onRequestPost({ request: chatRequest(), env: { GEMINI_API_KEY: secret } });
    const body = await r.text(); assert.equal(r.status, 502);
    assert.equal(body.includes(secret), false); assert.equal(logs.join(" ").includes(secret), false);
  } finally { globalThis.fetch = original; console.error = oldError; }
});
test("chat hides upstream connection error details", async () => {
  const original = globalThis.fetch, oldError = console.error, logs = [];
  globalThis.fetch = mockAuthenticatedFetch(async () => { throw new Error("connection leaked " + secret); });
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const r = await onRequestPost({ request: chatRequest(), env: { GEMINI_API_KEY: secret } });
    const body = await r.text(); assert.equal(r.status, 502);
    assert.equal(body.includes(secret), false); assert.equal(logs.join(" ").includes(secret), false);
  } finally { globalThis.fetch = original; console.error = oldError; }
});
