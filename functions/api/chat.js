const MODEL = "gemini-3.8-flash";
const sessions = new Map();
const requests = new Map();
const WINDOW_MS = 60_000;
const RATE_LIMIT = 20;
const MAX_HISTORY = 16;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function allowed(ip) {
  const now = Date.now();
  const recent = (requests.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  requests.set(ip, recent);
  return true;
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!allowed(ip)) return json(429, { error: "طلبات كثيرة. استنى دقيقة وجرب تاني." });

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return json(503, { error: "المساعد محتاج إعداد GEMINI_API_KEY في إعدادات Cloudflare." });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "صيغة الطلب غير صحيحة." });
  }

  const sessionId = typeof body?.sessionId === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(body.sessionId)
    ? body.sessionId : null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!sessionId || !message || message.length > 8000) {
    return json(400, { error: "اكتب رسالة صحيحة، وتأكد من طولها." });
  }

  const history = sessions.get(sessionId) || [];
  const contents = [...history.slice(-MAX_HISTORY), { role: "user", content: message }].map((item) => ({
    role: item.role === "assistant" ? "model" : "user",
    parts: [{ text: item.content }]
  }));

  try {
    const model = env.GEMINI_MODEL || MODEL;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You are Instinct, a helpful, careful AI assistant. Reply in the user's language. When the user writes Arabic, use clear, friendly Egyptian Arabic. Never claim to have performed an external action unless a tool actually confirmed it. Ask for approval before destructive or sensitive actions." }]
        },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(55_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Gemini API error:", upstream.status, data.error?.status || data.error?.code || "unknown");
      if (upstream.status === 429) return json(429, { error: "وصلنا لحد الاستخدام المتاح حاليًا في Gemini. جرّب بعد شوية." });
      if (upstream.status === 503) return json(503, { error: "خدمة Gemini مشغولة مؤقتًا. جرّب بعد شوية." });
      if ([400, 403, 404].includes(upstream.status)) return json(502, { error: "Gemini رفض الطلب. راجع صلاحية المفتاح واسم النموذج وإعدادات Gemini API." });
      return json(502, { error: "حصلت مشكلة في الاتصال بخدمة Gemini." });
    }

    const answer = (data.candidates?.[0]?.content?.parts || [])
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text).join("\n").trim();
    if (!answer) return json(502, { error: "Gemini لم يرجع نصًا. جرّب صياغة السؤال بطريقة مختلفة." });

    sessions.set(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: answer }].slice(-MAX_HISTORY));
    return json(200, { answer, model });
  } catch (error) {
    console.error("Chat request failed:", error.name);
    return json(504, { error: "الاتصال اتأخر. جرّب مرة تانية." });
  }
}
