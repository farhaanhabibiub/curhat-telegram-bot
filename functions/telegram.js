export async function onRequest(context) {
  const { request, env } = context;

  // Health check
  if (request.method === "GET") {
    return new Response("OK - Telegram webhook is running ✅", { status: 200 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Respond quickly to Telegram (avoid webhook timeout)
  context.waitUntil(handleUpdate(update, env));
  return new Response("OK", { status: 200 });
}

// ---------------------------
// Config
// ---------------------------
const MAX_HISTORY_TURNS = 8; // lebih hemat, tapi masih nyambung
const MAX_TEXT_LEN = 4000;

const MODEL_NAME = "gemini-2.5-flash"; // kamu bisa ganti kalau perlu

const SYSTEM_PROMPT = `
Kamu adalah teman ngobrol untuk curhat. Gaya bahasa: Indonesia santai, hangat, nggak menggurui.

Tujuan:
- Bantu user merasa didengar dan dimengerti.
- Refleksikan emosi user (“kedengarannya kamu capek banget…”).
- Kalau cocok, bantu user merapikan pikiran dengan pertanyaan lembut.
- Kalau user minta saran, kasih opsi yang ringan dan aman.

Aturan:
- Jawaban singkat-menengah (3–8 kalimat), lalu tanya 1 pertanyaan terbuka yang lembut.
- Jangan menghakimi.
- Jangan mengaku sebagai psikolog/terapis.
- Jangan memberi diagnosis medis/psikiatris.
- Jangan memaksa user melakukan sesuatu.
- Jika user membahas bunuh diri/self-harm atau bahaya serius, jangan lanjutkan sesi seperti biasa.
  Tanggap dengan empati, anjurkan cari bantuan profesional/orang terdekat, dan sarankan layanan darurat.

Konteks singkat (jika ada):
{summary}
`.trim();

const PRIVACY_TEXT =
  "🔒 Privasi\n\n" +
  "Aku menyimpan *riwayat chat singkat sementara* supaya obrolan nyambung.\n" +
  "Kamu bisa ketik /reset kapan pun untuk menghapus memory.\n\n" +
  "Aku bukan tenaga profesional. Kalau kamu sedang dalam bahaya atau ingin menyakiti diri, " +
  "tolong hubungi orang terdekat atau layanan darurat setempat.";

const HELP_TEXT =
  "✨ Bantuan\n\n" +
  "/start — mulai\n" +
  "/privacy — info privasi\n" +
  "/reset — hapus memory & mulai ulang\n\n" +
  "Kamu boleh curhat apa aja. Aku akan dengerin 🙂";

const START_TEXT =
  "Hai 🙂 aku bisa jadi teman ngobrol kamu.\n\n" +
  "Kamu boleh cerita apa aja. Aku akan dengerin tanpa nge-judge.\n\n" +
  "Ketik /privacy untuk info privasi, /reset untuk mulai dari nol, /help untuk bantuan.";

const CRISIS_RESPONSE =
  "Aku denger kamu lagi berat banget sampai kepikiran menyakiti diri. " +
  "Kamu nggak harus hadapi ini sendirian.\n\n" +
  "Kalau kamu *sedang dalam bahaya sekarang*, tolong hubungi *112* (darurat) atau minta bantuan orang terdekat ya.\n" +
  "Kalau kamu bisa, coba hubungi teman/keluarga yang kamu percaya dan bilang kamu lagi butuh ditemenin.\n\n" +
  "Aku tetap di sini. Kamu sekarang lagi sendirian atau ada orang di dekat kamu?";

// ---------------------------
// Helpers
// ---------------------------
function looksLikeCrisis(text) {
  const t = text.toLowerCase();
  const keywords = [
    "bunuh diri",
    "suicide",
    "pengen mati",
    "aku mau mati",
    "nggak pengen hidup",
    "self harm",
    "self-harm",
    "nyilet",
    "melukai diri",
    "mengakhiri hidup",
    "overdosis",
    "loncat",
    "gantung diri",
  ];
  return keywords.some((k) => t.includes(k));
}

function formatHistoryForPrompt(history) {
  const lines = [];
  for (const m of history) {
    const role = (m.role || "").toUpperCase();
    let content = (m.content || "").trim();
    if (content.length > 1500) content = content.slice(0, 1500) + "…";
    lines.push(`${role}: ${content}`);
  }
  return lines.join("\n");
}

function trimHistory(history) {
  const max = MAX_HISTORY_TURNS * 2;
  if (history.length > max) return history.slice(history.length - max);
  return history;
}

// ---------------------------
// KV helpers
// ---------------------------
async function kvGetHistory(env, userId) {
  if (!env.CURHAT_KV) return [];
  const raw = await env.CURHAT_KV.get(`hist:${userId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function kvSetHistory(env, userId, history) {
  if (!env.CURHAT_KV) return;
  await env.CURHAT_KV.put(`hist:${userId}`, JSON.stringify(history), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 hari
  });
}

async function kvReset(env, userId) {
  if (!env.CURHAT_KV) return;
  await env.CURHAT_KV.delete(`hist:${userId}`);
}

// Simple cooldown per user (anti spam)
async function cooldownRemainingMs(env, userId) {
  if (!env.CURHAT_KV) return 0;

  const key = `cool:${userId}`;
  const now = Date.now();

  const raw = await env.CURHAT_KV.get(key);
  const last = raw ? Number(raw) : 0;

  const COOLDOWN_MS = 15_000;

  if (last && now - last < COOLDOWN_MS) {
    return COOLDOWN_MS - (now - last);
  }

  // set timestamp, TTL 60 detik (minimal KV)
  await env.CURHAT_KV.put(key, String(now), { expirationTtl: 60 });
  return 0;
}

// Offline fallback (tanpa LLM) saat 429

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function offlineCurhatReply(userText, history) {
  const lastUser = [...history]
    .reverse()
    .find((m) => m.role === "user" && m.content !== userText)?.content;

  let base =
    "Aku dengerin kok 🙂 Kedengarannya ini lagi berat buat kamu.\n\n" +
    "Kalau kamu mau, coba ceritain: bagian yang paling bikin kamu kepikiran/kerasa sesek sekarang apa?";

  const t = userText.toLowerCase();
  const asksAdvice = [
    "gimana",
    "harus apa",
    "aku harus",
    "saran",
    "menurut kamu",
  ].some((k) => t.includes(k));

  if (asksAdvice) {
    base =
      "Aku paham kamu lagi bingung dan butuh arah. Aku bisa kasih beberapa opsi ringan:\n" +
      "1) Coba tulis 1–2 hal yang paling kamu takutkan dulu\n" +
      "2) Ambil jeda 5 menit (minum/napas) supaya kepala agak turun\n" +
      "3) Kalau bisa, cerita ke orang yang kamu percaya\n\n" +
      "Kalau kamu mau, kamu pengen fokus ke opsi yang mana dulu?";
  }

  if (lastUser) {
    base =
      "Aku inget barusan kamu sempat bilang: “" +
      lastUser.slice(0, 60) +
      (lastUser.length > 60 ? "…" : "") +
      "”.\n\n" +
      base;
  }

  return base;
}

// ---------------------------
// Main logic
// ---------------------------
async function handleUpdate(update, env) {
  try {
    const chatId = update?.message?.chat?.id;
    const userId = update?.message?.from?.id || chatId; // fallback
    const userText = (update?.message?.text || "").trim();

    if (!chatId || !userId || !userText) return;

    // Commands (tanpa LLM)
    if (userText === "/start")
      return await sendTelegram(env, chatId, START_TEXT);
    if (userText === "/help") return await sendTelegram(env, chatId, HELP_TEXT);
    if (userText === "/privacy")
      return await sendTelegram(env, chatId, PRIVACY_TEXT);
    if (userText === "/reset") {
      await kvReset(env, userId);
      return await sendTelegram(
        env,
        chatId,
        "Oke, aku hapus memory obrolan kita. Kita mulai dari nol ya 🙂"
      );
    }

    // Basic validations
    if (userText.length > MAX_TEXT_LEN) {
      return await sendTelegram(
        env,
        chatId,
        "Pesan kamu panjang banget 😅 Bisa dipendekin sedikit nggak? (maks 4000 karakter)"
      );
    }

    // Crisis
    if (looksLikeCrisis(userText)) {
      return await sendTelegram(env, chatId, CRISIS_RESPONSE);
    }

    // Cooldown
    const remaining = await cooldownRemainingMs(env, userId);

    if (remaining > 0) {
      // kasih tahu user sekali, lalu kita proses otomatis setelah cooldown
      await sendTelegram(env, chatId, "Tunggu sebentar ya 🙂 Aku lagi mikir…");

      // proses otomatis setelah cooldown selesai (tanpa user kirim lagi)
      await sleep(remaining);

      // setelah cooldown, proses pesan yang sama
      await processUserMessage(env, chatId, userId, userText);

      return;
    }

    // kalau tidak cooldown, proses langsung
    await processUserMessage(env, chatId, userId, userText);
    return;

    // Load history
    let history = await kvGetHistory(env, userId);

    // Save user message
    history.push({ role: "user", content: userText });
    history = trimHistory(history);

    // Build prompt (mirip versi python)
    const summary = "Belum ada ringkasan.";
    const historyText = formatHistoryForPrompt(history);
    const prompt = SYSTEM_PROMPT.replace("{summary}", summary);

    const fullInput =
      `${prompt}\n\n` +
      `---\n` +
      `Percakapan sejauh ini:\n${historyText}\n` +
      `---\n` +
      `USER: ${userText}\n` +
      `ASSISTANT:`;

    // Call Gemini
    let reply = await callGroq(env, fullInput);

    if (!reply) {
      reply = await callGemini(env, fullInput);
    }

    // Fallback offline if quota/rate limit (429)
    if (!reply) {
      reply = offlineCurhatReply(userText, history);
    }

    // Save assistant reply
    history.push({ role: "assistant", content: reply });
    history = trimHistory(history);

    await kvSetHistory(env, userId, history);

    return await sendTelegram(env, chatId, reply);
  } catch (e) {
    console.log("handleUpdate error:", e);
    try {
      const chatId = update?.message?.chat?.id;
      if (chatId)
        await sendTelegram(
          env,
          chatId,
          "Maaf, aku lagi error sebentar. Coba ulang ya 🙏"
        );
    } catch {}
  }
}

async function processUserMessage(env, chatId, userId, userText) {
  // load history dari KV
  let history = await kvGetHistory(env, userId);

  // simpan user message
  history.push({ role: "user", content: userText });
  history = trimHistory(history);

  const summary = "Belum ada ringkasan.";
  const historyText = formatHistoryForPrompt(history);
  const prompt = SYSTEM_PROMPT.replace("{summary}", summary);

  const fullInput =
    `${prompt}\n\n` +
    `---\n` +
    `Percakapan sejauh ini:\n${historyText}\n` +
    `---\n` +
    `USER: ${userText}\n` +
    `ASSISTANT:`;

  // Gemini -> Groq -> offline
  let reply = await callGroq(env, fullInput);
  if (!reply) reply = await callGemini(env, fullInput);
  if (!reply) reply = offlineCurhatReply(userText, history);

  // simpan assistant reply
  history.push({ role: "assistant", content: reply });
  history = trimHistory(history);

  await kvSetHistory(env, userId, history);

  await sendTelegram(env, chatId, reply);
}

// ---------------------------
// Gemini call
// ---------------------------
async function callGemini(env, inputText) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const modelName = "gemini-2.5-flash";
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let resp;
  try {
    resp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: inputText }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 200 },
      }),
    });
  } catch (e) {
    console.log("Gemini fetch error:", e);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.log("Gemini error:", resp.status, errText);

    // Cadangan: kalau gemini juga error, kita return null -> offline fallback
    return null;
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text || null;
}

async function callGroq(env, inputText) {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) return null;

  // Model cepat / murah
  const model = "llama-3.1-8b-instant";
  // Model lebih bagus (lebih berat):
  // const model = "llama-3.1-70b-versatile";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let resp;
  try {
    resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "Kamu adalah teman curhat yang hangat. Bahasa Indonesia santai, tidak menggurui. " +
              "Jawab 3–8 kalimat, lalu tanya 1 pertanyaan lembut. Jangan mengaku psikolog/terapis. " +
              "Jangan memberi diagnosis. Jangan mengarang fakta.",
          },
          { role: "user", content: inputText },
        ],
        temperature: 0.6,
        max_tokens: 220,
      }),
    });
  } catch (e) {
    console.log("Groq fetch error:", e);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    console.log("Groq error:", resp.status, errText);

    // Fallback to Gemini on any Groq error/limit
    return null;
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

// ---------------------------
// Telegram send
// ---------------------------
async function sendTelegram(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!resp.ok) {
    console.log("Telegram sendMessage failed:", await resp.text());
  }
}
