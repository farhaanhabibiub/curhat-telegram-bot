export async function onRequest(context) {
  const { request, env } = context;

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

  context.waitUntil(handleUpdate(update, env));
  return new Response("OK", { status: 200 });
}

const MAX_HISTORY_TURNS = 14; // sama kayak python
const MAX_TEXT_LEN = 4000;

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

// KV helpers
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
  await env.CURHAT_KV.put(`hist:${userId}`, JSON.stringify(history));
}

async function kvReset(env, userId) {
  if (!env.CURHAT_KV) return;
  await env.CURHAT_KV.delete(`hist:${userId}`);
}

function trimHistory(history) {
  const max = MAX_HISTORY_TURNS * 2;
  if (history.length > max) return history.slice(history.length - max);
  return history;
}

async function handleUpdate(update, env) {
  try {
    const chatId = update?.message?.chat?.id;
    const userId = update?.message?.from?.id;
    const userText = (update?.message?.text || "").trim();

    if (!chatId || !userId || !userText) return;

    // commands
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

    if (userText.length > MAX_TEXT_LEN) {
      return await sendTelegram(
        env,
        chatId,
        "Pesan kamu panjang banget 😅 Bisa dipendekin sedikit nggak? (maks 4000 karakter)"
      );
    }

    if (looksLikeCrisis(userText)) {
      return await sendTelegram(env, chatId, CRISIS_RESPONSE);
    }

    // load history dari KV
    let history = await kvGetHistory(env, userId);

    // simpan user message ke history
    history.push({ role: "user", content: userText });
    history = trimHistory(history);

    // bangun prompt seperti versi python
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

    const reply = await callGemini(env, fullInput);

    // simpan assistant reply ke history
    history.push({ role: "assistant", content: reply });
    history = trimHistory(history);

    await kvSetHistory(env, userId, history);

    return await sendTelegram(env, chatId, reply);
  } catch (e) {
    console.log("handleUpdate error:", e);
  }
}

async function callGemini(env, inputText) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let geminiResp;
  try {
    geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: inputText }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 250 },
      }),
    });
  } catch (e) {
    console.log("Gemini fetch error:", e);
    return "Maaf, aku lagi gagal menghubungi AI (timeout/jaringan). Coba ulang ya 🙏";
  } finally {
    clearTimeout(timeout);
  }

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    return `Gemini error (${geminiResp.status}): ${errText.slice(0, 200)}`;
  }

  const data = await geminiResp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  return (
    text ||
    "Aku dengerin kok. Kamu mau cerita bagian yang paling beratnya yang mana?"
  );
}

async function sendTelegram(env, chatId, text) {
  const resp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );

  if (!resp.ok) {
    console.log("Telegram sendMessage failed:", await resp.text());
  }
}
