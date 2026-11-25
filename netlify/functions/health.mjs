const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

export default async function handler(request) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Allow": "GET", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  return new Response(JSON.stringify({
    ok: true,
    service: "instinct-ai",
    model: MODEL,
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY)
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
