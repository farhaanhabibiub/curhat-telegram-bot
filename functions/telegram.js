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

  // Proses di background supaya Telegram gak timeout
  context.waitUntil(handleUpdate(update, env));

  // Balas cepat
  return new Response("OK", { status: 200 });
}

async function handleUpdate(update, env) {
  try {
    const chatId = update?.message?.chat?.id;
    const userText = (update?.message?.text || "").trim();

    if (!chatId || !userText) return;

    console.log("Incoming message:", {
      chatId,
      textPreview: userText.slice(0, 30),
    });
    console.log("Env present:", {
      hasTelegram: !!env.TELEGRAM_BOT_TOKEN,
      hasGemini: !!env.GEMINI_API_KEY,
    });

    // COMMANDS (tanpa Gemini)
    if (userText === "/start") {
      return await sendTelegram(
        env,
        chatId,
        "Hai 🙂 aku bisa jadi teman ngobrol kamu.\n\n" +
          "Kamu boleh cerita apa aja. Aku akan dengerin tanpa nge-judge.\n\n" +
          "Perintah: /help /privacy /reset"
      );
    }

    if (userText === "/help") {
      return await sendTelegram(
        env,
        chatId,
        "✨ Bantuan\n\n" +
          "/start — mulai\n" +
          "/privacy — info privasi\n" +
          "/reset — hapus memory (sementara ini bot belum simpan memory)\n\n" +
          "Kamu boleh curhat apa aja 🙂"
      );
    }

    if (userText === "/privacy") {
      return await sendTelegram(
        env,
        chatId,
        "🔒 Privasi\n\n" +
          "Versi ini *tidak menyimpan riwayat chat*.\n" +
          "Aku hanya memproses pesan untuk membalas.\n\n" +
          "Aku bukan tenaga profesional. Kalau kamu sedang dalam bahaya, hubungi 112 atau orang terdekat."
      );
    }

    if (userText === "/reset") {
      return await sendTelegram(
        env,
        chatId,
        "Oke 🙂 Aku sudah reset. (Catatan: bot ini tidak menyimpan memory, jadi sebenarnya selalu 'fresh' tiap chat.)"
      );
    }

    // CRISIS CHECK
    const t = userText.toLowerCase();
    const crisisKeywords = [
      "bunuh diri",
      "pengen mati",
      "nggak pengen hidup",
      "mengakhiri hidup",
      "self harm",
      "self-harm",
      "nyilet",
      "melukai diri",
      "overdosis",
      "gantung diri",
      "loncat",
    ];
    const isCrisis = crisisKeywords.some((k) => t.includes(k));

    if (isCrisis) {
      return await sendTelegram(
        env,
        chatId,
        "Aku denger kamu lagi berat banget sampai kepikiran menyakiti diri. Kamu nggak harus hadapi ini sendirian.\n\n" +
          "Kalau kamu *sedang dalam bahaya sekarang*, tolong hubungi *112* atau minta bantuan orang terdekat ya.\n\n" +
          "Aku tetap di sini. Kamu sekarang lagi sendirian atau ada orang di dekat kamu?"
      );
    }

    // Validasi env
    if (!env.GEMINI_API_KEY) {
      return await sendTelegram(
        env,
        chatId,
        "Aku belum disetup lengkap 😅 (GEMINI_API_KEY belum kebaca di Cloudflare). " +
          "Coba cek Environment Variables (Production) lalu redeploy."
      );
    }

    if (userText.length < 3) {
      return "Aku di sini kok 🙂 Kalau kamu mau, kamu bisa ceritain sedikit aja: apa yang lagi kamu rasain sekarang?";
    }

    // Call Gemini
    const replyText = await callGemini(env, userText);

    return await sendTelegram(env, chatId, replyText);
  } catch (e) {
    console.log("handleUpdate error:", e);
  }
}

async function callGemini(env, userText) {
  const systemPrompt =
    "Kamu adalah teman curhat yang hangat, dewasa, dan tidak menggurui. Bahasa: Indonesia santai.\n" +
    "Tugasmu: dengarkan, refleksikan perasaan user, lalu tanyakan 1 pertanyaan lembut untuk membantu user bercerita.\n" +
    "Gaya jawaban:\n" +
    "- 3 sampai 7 kalimat saja.\n" +
    "- Jangan mengarang fakta tentang user.\n" +
    "- Jangan sok tahu / jangan menyimpulkan berlebihan.\n" +
    "- Jangan menyebut kata 'system prompt'.\n" +
    "- Jangan memberi diagnosis medis/psikiatris.\n" +
    "- Jika user meminta saran: berikan 2-3 opsi ringan yang aman.\n" +
    "Struktur jawaban wajib:\n" +
    "1) Validasi/empati (1-2 kalimat)\n" +
    "2) Refleksi (1-2 kalimat)\n" +
    "3) Pertanyaan lembut (1 kalimat)\n";

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
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${systemPrompt}\n\nPesan user (kutip persis, jangan ubah): """${userText}"""\n\nBalas sebagai teman curhat:`,
              },
            ],
          },
        ],
        generationConfig: { temperature: 0.5, maxOutputTokens: 220 },
      }),
    });
  } catch (e) {
    console.log("Gemini fetch error:", e);
    return "Maaf, aku lagi gagal menghubungi AI (timeout/jaringan). Coba ulang ya 🙏";
  } finally {
    clearTimeout(timeout);
  }

  console.log("Gemini response:", {
    status: geminiResp.status,
    ok: geminiResp.ok,
  });

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();

    // Kirim info error ringkas ke user (debug sementara)
    return `Gemini error (${geminiResp.status}): ${errText.slice(0, 200)}`;
  }

  const data = await geminiResp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return text || "Aku dengerin kok. Kamu mau cerita lebih lanjut?";
}

async function sendTelegram(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log("Missing TELEGRAM_BOT_TOKEN");
    return;
  }

  const resp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }
  );

  console.log("Telegram sendMessage:", { status: resp.status, ok: resp.ok });

  if (!resp.ok) {
    console.log("Telegram sendMessage error body:", await resp.text());
  }
}
