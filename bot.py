import os
import asyncio
from typing import Dict, List
from dataclasses import dataclass
from dotenv import load_dotenv

from aiogram import Bot, Dispatcher, F
from aiogram.types import Message
from aiogram.filters import CommandStart, Command

import google.generativeai as genai

# --------------------
# Load env
# --------------------
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not TELEGRAM_BOT_TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN belum di-set di .env")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY belum di-set di .env")

# --------------------
# Configure Gemini
# --------------------
genai.configure(api_key=GEMINI_API_KEY)
# Model yang cepat dan murah (cocok untuk chat):
GEMINI_MODEL_NAME = "gemini-2.5-flash"
model = genai.GenerativeModel(GEMINI_MODEL_NAME)

# --------------------
# Telegram setup
# --------------------
bot = Bot(token=TELEGRAM_BOT_TOKEN)
dp = Dispatcher()

# --------------------
# Memory sederhana per user (MVP)
# Untuk production: pindah ke Postgres/Redis
# --------------------
MAX_HISTORY_TURNS = 14  # jumlah pesan yang disimpan (role-based)
MAX_TEXT_LEN = 4000     # batasi input user supaya aman

@dataclass
class ChatState:
    history: List[dict]
    summary: str = ""  # bisa kamu pakai nanti untuk ringkasan

USER_STATE: Dict[int, ChatState] = {}

def get_state(user_id: int) -> ChatState:
    if user_id not in USER_STATE:
        USER_STATE[user_id] = ChatState(history=[])
    return USER_STATE[user_id]

def push_history(user_id: int, role: str, content: str):
    state = get_state(user_id)
    state.history.append({"role": role, "content": content})

    # potong agar tidak kepanjangan
    if len(state.history) > MAX_HISTORY_TURNS * 2:
        state.history = state.history[-MAX_HISTORY_TURNS * 2:]

# --------------------
# Persona prompt untuk curhat
# --------------------
SYSTEM_PROMPT = """
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
""".strip()

PRIVACY_TEXT = (
    "🔒 *Privasi*\n\n"
    "Aku menyimpan *riwayat chat singkat sementara* supaya obrolan nyambung.\n"
    "Kamu bisa ketik /reset kapan pun untuk menghapus memory.\n\n"
    "Aku bukan tenaga profesional. Kalau kamu sedang dalam bahaya atau ingin menyakiti diri, "
    "tolong hubungi orang terdekat atau layanan darurat setempat."
)

HELP_TEXT = (
    "✨ *Bantuan*\n\n"
    "Kamu bisa pakai perintah ini:\n"
    "- /start — mulai\n"
    "- /privacy — info privasi\n"
    "- /reset — hapus memory & mulai ulang\n\n"
    "Kamu boleh curhat apa aja. Aku akan dengerin 🙂"
)

CRISIS_RESPONSE = (
    "Aku denger kamu lagi berat banget sampai kepikiran menyakiti diri. "
    "Kamu nggak harus hadapi ini sendirian.\n\n"
    "Kalau kamu *sedang dalam bahaya sekarang*, tolong hubungi *112* (darurat) atau minta bantuan orang terdekat ya.\n"
    "Kalau kamu bisa, coba hubungi teman/keluarga yang kamu percaya dan bilang kamu lagi butuh ditemenin.\n\n"
    "Aku tetap di sini. Kamu sekarang lagi sendirian atau ada orang di dekat kamu?"
)

def looks_like_crisis(text: str) -> bool:
    t = text.lower()
    keywords = [
        "bunuh diri", "suicide", "pengen mati", "aku mau mati", "nggak pengen hidup",
        "self harm", "self-harm", "nyilet", "melukai diri", "mengakhiri hidup",
        "overdosis", "loncat", "gantung diri"
    ]
    return any(k in t for k in keywords)

# --------------------
# Gemini call
# --------------------
def format_history_for_prompt(history: List[dict]) -> str:
    """
    Gemini paling stabil kalau kita kirim prompt berbentuk teks percakapan.
    """
    lines = []
    for m in history:
        role = m["role"].upper()
        content = m["content"].strip()
        # Biar ringkas:
        if len(content) > 1500:
            content = content[:1500] + "…"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)

async def ask_gemini(user_id: int, user_text: str) -> str:
    state = get_state(user_id)

    history = state.history[-MAX_HISTORY_TURNS * 2:]
    history_text = format_history_for_prompt(history)

    prompt = SYSTEM_PROMPT.format(summary=state.summary or "Belum ada ringkasan.")
    full_input = (
        f"{prompt}\n\n"
        f"---\n"
        f"Percakapan sejauh ini:\n{history_text}\n"
        f"---\n"
        f"USER: {user_text}\n"
        f"ASSISTANT:"
    )

    # generate_content bersifat blocking; kita jalankan di thread supaya tidak mengunci event loop
    def _call():
        resp = model.generate_content(full_input)
        return (resp.text or "").strip()

    reply = await asyncio.to_thread(_call)

    # fallback kalau kosong
    if not reply:
        reply = "Aku dengerin kok. Kamu mau cerita bagian yang paling beratnya yang mana?"

    # batasi panjang output
    if len(reply) > 2000:
        reply = reply[:2000] + "…"

    return reply

# --------------------
# Handlers
# --------------------
@dp.message(CommandStart())
async def start(message: Message):
    text = (
        "Hai 🙂 aku bisa jadi teman ngobrol kamu.\n\n"
        "Kamu boleh cerita apa aja. Aku akan dengerin tanpa nge-judge.\n\n"
        "Ketik /privacy untuk info privasi, /reset untuk mulai dari nol, /help untuk bantuan."
    )
    await message.answer(text)

@dp.message(Command("privacy"))
async def privacy(message: Message):
    await message.answer(PRIVACY_TEXT, parse_mode="Markdown")

@dp.message(Command("help"))
async def help_cmd(message: Message):
    await message.answer(HELP_TEXT, parse_mode="Markdown")

@dp.message(Command("reset"))
async def reset(message: Message):
    USER_STATE.pop(message.from_user.id, None)
    await message.answer("Oke, aku hapus memory obrolan kita. Kita mulai dari nol ya 🙂")

@dp.message(F.text)
async def on_text(message: Message):
    user_id = message.from_user.id
    user_text = (message.text or "").strip()

    if not user_text:
        return

    # batasi input
    if len(user_text) > MAX_TEXT_LEN:
        await message.answer("Pesan kamu panjang banget 😅 Bisa dipendekin sedikit nggak? (maks 4000 karakter)")
        return

    # crisis check
    if looks_like_crisis(user_text):
        await message.answer(CRISIS_RESPONSE)
        return

    # simpan user message
    push_history(user_id, "user", user_text)

    try:
        reply = await ask_gemini(user_id, user_text)
    except Exception as e:
        print("ERROR saat memanggil Gemini:", type(e), repr(e))
        await message.answer("Maaf, aku lagi error sebentar. Coba ulang ya 🙏")
        return

    # simpan bot reply
    push_history(user_id, "assistant", reply)

    await message.answer(reply)

# --------------------
# Main
# --------------------
async def main():
    print(f"✅ Bot running with model: {GEMINI_MODEL_NAME}")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
