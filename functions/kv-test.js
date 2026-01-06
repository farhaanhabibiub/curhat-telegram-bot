export async function onRequest(context) {
  const { env } = context;

  if (!env.CURHAT_KV) {
    return new Response("CURHAT_KV binding NOT FOUND ❌", { status: 500 });
  }

  await env.CURHAT_KV.put("ping", "ok");
  const val = await env.CURHAT_KV.get("ping");

  return new Response(`KV OK ✅ ping=${val}`, { status: 200 });
}
