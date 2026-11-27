import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Load a local .env file without adding a runtime dependency. Existing host
// environment variables always take precedence.
try {
  const envText = await readFile(join(ROOT, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const sessions = new Map();
const requests = new Map();
const MAX_BODY = 32 * 1024;
const MAX_HISTORY = 16;
const WINDOW_MS = 60_000;
const RATE_LIMIT = 20;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error("BODY_TOO_LARGE");
  }
  return JSON.parse(raw || "{}");
}

function allowed(ip) {
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

async function chat(req, res) {
  if (!allowed(req.socket.remoteAddress || "unknown")) {
    return send(res, 429, { error: "طلبات كثيرة. استنى دقيقة وجرب تاني." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return send(res, 503, { error: "المساعد لسه محتاج إعداد GEMINI_API_KEY على الاستضافة." });
  }

  let body;
  try { body = await readBody(req); }
  catch (error) {
    return send(res, error.message === "BODY_TOO_LARGE" ? 413 : 400,
      { error: error.message === "BODY_TOO_LARGE" ? "الرسالة كبيرة جدًا." : "صيغة الطلب غير صحيحة." });
  }

  const sessionId = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(body.sessionId)
    ? body.sessionId : null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!sessionId || !message || message.length > 8000) {
    return send(res, 400, { error: "اكتب رسالة صحيحة، وتأكد من طولها." });
  }

  const history = sessions.get(sessionId) || [];
  const contents = [
    ...history.slice(-MAX_HISTORY),
    { role: "user", content: message }
  ].map(item => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "You are Instinct, a helpful, careful AI assistant. Reply in the user's language. When the user writes Arabic, use clear, friendly Egyptian Arabic. Never claim to have performed an external action unless a tool actually confirmed it. Ask for approval before destructive or sensitive actions."
          }]
        },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(90_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const apiCode = data.error?.status || data.error?.code || "unknown";
      console.error("Gemini API error:", upstream.status, apiCode);
      if (upstream.status === 429) {
        return send(res, 429, { error: "وصلنا لحد الاستخدام المتاح حاليًا في Gemini. جرّب بعد شوية." });
      }
      if (upstream.status === 503) {
        return send(res, 503, { error: "خدمة Gemini مشغولة مؤقتًا. جرّب بعد شوية." });
      }
      if (upstream.status === 400 || upstream.status === 403 || upstream.status === 404) {
        return send(res, 502, { error: "Gemini رفض الطلب. راجع صلاحية المفتاح واسم النموذج وإعدادات Gemini API." });
      }
      return send(res, 502, { error: "حصلت مشكلة في الاتصال بخدمة Gemini." });
    }

    const answer = (data.candidates?.[0]?.content?.parts || [])
      .filter(part => typeof part.text === "string")
      .map(part => part.text)
      .join("\n").trim();

    if (!answer) {
      const reason = data.candidates?.[0]?.finishReason;
      console.error("Gemini returned no text:", reason || "unknown");
      return send(res, 502, { error: "Gemini لم يرجع نصًا. جرّب صياغة السؤال بطريقة مختلفة." });
    }

    sessions.set(sessionId, [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: answer }
    ].slice(-MAX_HISTORY));
    return send(res, 200, { answer, model: MODEL });
  } catch (error) {
    console.error("Chat request failed:", error.name);
    return send(res, 504, { error: "الاتصال اتأخر. جرّب مرة تانية." });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "instinct-ai", model: MODEL, apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY) });
  }
  if (req.method === "POST" && url.pathname === "/api/chat") return chat(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });

  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = normalize(join(PUBLIC, requested));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: "Forbidden" });
  try {
    const content = await readFile(file);
    return send(res, 200, content, mime[extname(file)] || "application/octet-stream");
  } catch {
    return send(res, 404, { error: "Not found" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Instinct AI listening on port ${PORT}`);
});
