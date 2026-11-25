const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const sessions = new Map();
const requests = new Map();
const WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const MAX_HISTORY = 16;

function reply(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function allowed(ip) {
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return reply(res, 405, { error: "Method not allowed" });
  }

  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  if (!allowed(ip)) return reply(res, 429, { error: "طلبات كثيرة. استنى دقيقة وجرب تاني." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return reply(res, 503, { error: "المساعد لسه محتاج إعداد GEMINI_API_KEY في إعدادات Vercel." });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return null; } })() : req.body;
  if (!body || typeof body !== "object") return reply(res, 400, { error: "صيغة الطلب غير صحيحة." });

  const sessionId = typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(body.sessionId) ? body.sessionId : null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!sessionId || !message || message.length > 8000) {
    return reply(res, 400, { error: "اكتب رسالة صحيحة، وتأكد من طولها." });
  }

  const history = sessions.get(sessionId) || [];
  const contents = [...history.slice(-MAX_HISTORY), { role: "user", content: message }].map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are Instinct, a helpful, careful AI assistant. Reply in the user's language. When the user writes Arabic, use clear, friendly Egyptian Arabic. Never claim to have performed an external action unless a tool actually confirmed it. Ask for approval before destructive or sensitive actions." }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(55_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Gemini API error:", upstream.status, data.error?.status || data.error?.code || "unknown");
      if (upstream.status === 429) return reply(res, 429, { error: "وصلنا لحد الاستخدام المتاح حاليًا في Gemini. جرّب بعد شوية." });
      if (upstream.status === 503) return reply(res, 503, { error: "خدمة Gemini مشغولة مؤقتًا. جرّب بعد شوية." });
      if ([400, 403, 404].includes(upstream.status)) return reply(res, 502, { error: "Gemini رفض الطلب. راجع صلاحية المفتاح واسم النموذج وإعدادات Gemini API." });
      return reply(res, 502, { error: "حصلت مشكلة في الاتصال بخدمة Gemini." });
    }

    const answer = (data.candidates?.[0]?.content?.parts || [])
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text).join("\n").trim();
    if (!answer) return reply(res, 502, { error: "Gemini لم يرجع نصًا. جرّب صياغة السؤال بطريقة مختلفة." });

    sessions.set(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: answer }].slice(-MAX_HISTORY));
    return reply(res, 200, { answer, model: MODEL });
  } catch (error) {
    console.error("Chat request failed:", error.name);
    return reply(res, 504, { error: "الاتصال اتأخر. جرّب مرة تانية." });
  }
}
