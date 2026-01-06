export async function onRequest(context) {
  const { request, env } = context;

  // Health check
  if (request.method === "GET") {
    return new Response("OK - Telegram webhook is running ✅", { status: 200 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const update = await request.json();

  const chatId = update?.message?.chat?.id;
  const userText = update?.message?.text;

  if (!chatId || !userText) {
    return new Response("No message", { status: 200 });
  }

  // Basic crisis detection
  const t = userText.toLowerCase();
  const crisisKeywords = [
    "bunuh diri", "pengen mati", "nggak pengen hidup", "mengakhiri hidup",
    "self harm", "self-harm", "nyilet", "melukai diri"
  ];
  const isCrisis = crisisKeywords.some(k => t.includes(k));

  let replyText = "";

  if (isCrisis) {
    replyText =
      "Aku denger kamu lagi berat banget sampai kepikiran menyakiti diri. Kamu nggak harus hadapi ini sendirian.\n\n" +
      "Kalau kamu sedang dalam bahaya sekarang, tolong hubungi 112 atau minta bantuan orang terdekat ya.\n" +
      "Aku tetap di sini. Kamu sekarang lagi sendirian atau ada orang di dekat kamu?";
  } else {
    // Call Gemini
    const systemPrompt =
      "Kamu adalah teman ngobrol untuk curhat. Gaya bahasa: Indonesia santai, hangat, nggak menggurui.\n" +
      "Jawab singkat-menengah (3–8 kalimat), lalu tanya 1 pertanyaan lembut.\n" +
      "Jangan mengaku sebagai psikolog/terapis. Jangan memberi diagnosis.\n";

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

    const geminiResp = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\nUSER: ${userText}\nASSISTANT:` }]
          }
        ],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 250
        }
      })
    });

    if (!geminiResp.ok) {
      const err = await geminiResp.text();
      console.log("Gemini error:", err);
      replyText = "Maaf, aku lagi error sebentar. Coba ulang ya 🙏";
    } else {
      const data = await geminiResp.json();
      replyText =
        data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        || "Aku dengerin kok. Kamu mau cerita lebih lanjut?";
    }
  }

  // Reply to Telegram
  const telegramResp = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText
      })
    }
  );

  if (!telegramResp.ok) {
    console.log("Telegram sendMessage failed:", await telegramResp.text());
  }

  return new Response("OK", { status: 200 });
}