import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Load a local .env file without adding a runtime dependency. Existing host
// environment variables always take precedence.
try {
  const envText = await readFile(join(ROOT, ".env"), "utf8");
  for (const line of envText.split(/\\r?\\n/)) {
    const match = line.match(/^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\\1$/, "$2");
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
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
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, { error: "المساعد لسه محتاج إعداد OPENAI_API_KEY على الاستضافة." });
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
  const input = [
    ...history.slice(-MAX_HISTORY),
    { role: "user", content: message }
  ];

  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        instructions: "You are Instinct, a helpful, careful AI assistant. Reply in the user's language. When the user writes Arabic, use clear, friendly Egyptian Arabic. Never claim to have performed an external action unless a tool actually confirmed it. Ask for approval before destructive or sensitive actions.",
        input,
        store: false
      }),
      signal: AbortSignal.timeout(90_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("OpenAI API error:", upstream.status, data.error?.code || data.error?.type || "unknown");
      return send(res, upstream.status === 429 ? 429 : 502, {
        error: upstream.status === 429
          ? "خدمة الذكاء الاصطناعي مشغولة حاليًا. جرّب بعد شوية."
          : "حصلت مشكلة في الاتصال بخدمة الذكاء الاصطناعي. راجع إعدادات المفتاح والموديل."
      });
    }

    const answer = (data.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n").trim();

    if (!answer) return send(res, 502, { error: "وصل رد فاضي من النموذج. جرّب تاني." });

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
    return send(res, 200, { ok: true, service: "instinct-ai", model: MODEL, apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY) });
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