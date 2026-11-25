export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({
    ok: true,
    service: "instinct-ai",
    model: env.GEMINI_MODEL || "gemini-3.8-flash",
    apiKeyConfigured: Boolean(env.GEMINI_API_KEY)
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
