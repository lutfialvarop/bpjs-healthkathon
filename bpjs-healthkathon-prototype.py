# bpjs-healthkathon-prototype.py
import os, re, base64, threading, socket
from pathlib import Path
from textwrap import dedent
import streamlit as st
import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import numpy as np
import io
import soundfile as sf  # pip install soundfile
import torch
from transformers import VitsModel, AutoTokenizer  # pip install transformers torch
from fastapi import Response
from typing import Optional

# ---------- Paths ----------
ROOT = Path(__file__).parent
TEMPLATE_DIR = ROOT / "templates"
HTML_PATH = TEMPLATE_DIR / "mobile_jkn.html"
CSS_PATH  = TEMPLATE_DIR / "mobile_jkn.css"
JS_PATH   = TEMPLATE_DIR / "mobile_jkn.js"

# adjust your assets folder here
parents_folder = "./"
ASSETS = Path(parents_folder) / "assets"

RAG_DIR = ROOT / "rag"

def load_rag_chunks():
    chunks = []
    if not RAG_DIR.exists():
        print(f"❌ RAG directory not found: {RAG_DIR}")
        return chunks
        
    for f in RAG_DIR.glob("*.txt"):
        try:
            text = f.read_text(encoding="utf-8")
            blocks = text.split("\n\n")
            for block in blocks:
                clean = block.strip()
                if len(clean) > 30:
                    chunks.append({
                        "file": f.name,
                        "text": clean
                    })
        except Exception as e:
            print(f"❌ Failed to load RAG file {f}: {e}")
    print(f"✅ Loaded {len(chunks)} RAG chunks")
    return chunks

RAG_CHUNKS = load_rag_chunks()



# This is for VITS TTS Block
# ========== SINGLE-FILE VITS TTS (facebook/mms-tts-ind) ==========
_TTS_MODEL_ID = "facebook/mms-tts-ind"
_TTS_MODEL = None
_TTS_TOKENIZER = None

def _load_tts_singleton():
    """Lazy-load and cache MMS-VITS (Indonesian). Uses CUDA if available."""
    global _TTS_MODEL, _TTS_TOKENIZER
    if _TTS_MODEL is None or _TTS_TOKENIZER is None:
        _TTS_TOKENIZER = AutoTokenizer.from_pretrained(_TTS_MODEL_ID)
        _TTS_MODEL = VitsModel.from_pretrained(_TTS_MODEL_ID)
        if torch.cuda.is_available():
            _TTS_MODEL.to("cuda")
    return _TTS_MODEL, _TTS_TOKENIZER

def get_numpy_waveform(text: str, sample_rate: Optional[int] = None):

    """
    Generate a numpy waveform (1-D float32) for the given text.
    Returns: (waveform_np, sampling_rate)
    """
    text = (text or "").strip()
    if not text:
        # short silence
        return np.zeros(1600, dtype=np.float32), 16000

    model, tokenizer = _load_tts_singleton()
    inputs = tokenizer(text, return_tensors="pt")
    if torch.cuda.is_available():
        inputs = {k: v.to("cuda") for k, v in inputs.items()}

    with torch.no_grad():
        out = model(**inputs).waveform  # [1, T], device = cpu/cuda

    wav = out.squeeze().detach().cpu().numpy().astype("float32")
    sr = sample_rate or getattr(model.config, "sampling_rate", 16000)
    return wav, int(sr)
# ================================================================

# ---------- Preload + warm-up TTS so first speech is instant ----------
def _preload_tts_async():
    def _task():
        try:
            # download weights + move to CUDA if available
            _load_tts_singleton()
            # do a tiny synthesis to allocate kernels / graph, fill caches
            _ = get_numpy_waveform("Halo. Tes suara.", sample_rate=16000)
            print("✅ TTS model preloaded & warmed up")
        except Exception as e:
            print(f"❌ TTS preload failed: {e}")
    threading.Thread(target=_task, daemon=True).start()

# call once at startup
_preload_tts_async()

# ---------- Local Embedding Model ----------
embedding_model = None
RAG_EMBEDDINGS = []

def load_embedding_model():
    """Load local embedding model once"""
    global embedding_model
    if embedding_model is None:
        try:
            # Try to import sentence-transformers
            from sentence_transformers import SentenceTransformer
            # Lightweight model - much faster than API calls
            embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
            print("✅ Local embedding model loaded")
            return embedding_model
        except ImportError as e:
            print(f"❌ Import error: {e}")
            st.error(f"❌ Import error: {e}")
            return None
        except Exception as e:
            print(f"❌ Failed to load local model: {e}")
            st.error(f"❌ Failed to load local model: {e}")
            return None
    return embedding_model

def embed_text_local(text: str):
    """Use local embedding model - much faster"""
    try:
        model = load_embedding_model()
        if model is None:
            print("❌ No embedding model available")
            return None
            
        # Process the text
        embedding = model.encode([text])[0]  # Returns numpy array
        return embedding.astype(float)
        
    except Exception as e:
        print(f"❌ Local embedding failed: {e}")
        return None

def precompute_all_embeddings():
    """Precompute embeddings for all chunks at startup"""
    global RAG_EMBEDDINGS
    print("🔄 Precomputing all embeddings...")
    chunk_embeddings = []
    
    model = load_embedding_model()
    if model is None:
        print("❌ Cannot precompute embeddings - no model available")
        return []
    
    for i, chunk in enumerate(RAG_CHUNKS):
        print(f"🔄 Embedding chunk {i+1}/{len(RAG_CHUNKS)}")
        embedding = embed_text_local(chunk["text"])
        chunk_embeddings.append(embedding)
    
    print(f"✅ Precomputed {len(chunk_embeddings)} embeddings")
    return chunk_embeddings

# Try to precompute embeddings at startup
try:
    if RAG_CHUNKS:
        RAG_EMBEDDINGS = precompute_all_embeddings()
    else:
        print("❌ No RAG chunks to embed")
except Exception as e:
    print(f"❌ Failed to precompute embeddings: {e}")
    RAG_EMBEDDINGS = []

def retrieve_rag(query: str, k: int = 4):
    """Fast retrieval using precomputed local embeddings"""
    if not RAG_CHUNKS or not RAG_EMBEDDINGS:
        print("❌ No RAG chunks or embeddings available")
        return []
        
    q_emb = embed_text_local(query)
    
    if q_emb is None:
        print("❌ Query embedding failed, returning empty results")
        return []
    
    scores = []
    for i, (chunk, c_emb) in enumerate(zip(RAG_CHUNKS, RAG_EMBEDDINGS)):
        if c_emb is None:
            continue
            
        try:
            # Calculate cosine similarity with safety checks
            dot_product = np.dot(q_emb, c_emb)
            norm_q = np.linalg.norm(q_emb)
            norm_c = np.linalg.norm(c_emb)
            
            # Avoid division by zero
            if norm_q == 0 or norm_c == 0:
                score = 0.0
            else:
                score = float(dot_product / (norm_q * norm_c))
                
            scores.append((score, chunk))
        except Exception as e:
            print(f"❌ Similarity calculation failed for chunk: {e}")
            continue
    
    # Sort by score descending and return top k
    scores.sort(key=lambda x: x[0], reverse=True)
    results = [c for _, c in scores[:k]]
    print(f"✅ RAG retrieval found {len(results)} relevant chunks")
    return results

API_KEY = os.getenv("MY_APP_API_KEY")

# 2. (WAJIB) Periksa apakah key tersebut ada
if not API_KEY:
    # Jika aplikasi tidak bisa jalan tanpa key, hentikan di sini
    st.error("FATAL: Environment variable 'MY_APP_API_KEY' tidak di-set.")
    st.stop() 
os.environ["OPENROUTER_API_KEY"] = API_KEY

if "OPENROUTER_API_KEY" not in st.session_state or not st.session_state["OPENROUTER_API_KEY"]:
    st.session_state["OPENROUTER_API_KEY"] = API_KEY

def get_api_key() -> str:
    return (st.session_state.get("OPENROUTER_API_KEY") or
            os.getenv("OPENROUTER_API_KEY") or
            API_KEY or "")

st.set_page_config(page_title="Mobile JKN – Mobile Mock", page_icon="🩺", layout="wide", initial_sidebar_state="collapsed")

# ---------- Helpers ----------
def data_uri(path: str, label: str = "") -> str:
    p = Path(path)
    if p.exists():
        ext = p.suffix.lower()
        if ext in [".png"]:
            mime = "image/png"
        elif ext in [".jpg", ".jpeg"]:
            mime = "image/jpeg"
        elif ext in [".svg"]:
            mime = "image/svg+xml"
        else:
            mime = "image/png"
        b64 = base64.b64encode(p.read_bytes()).decode()
        return f"data:{mime};base64,{b64}"
    text = (label or "img")[:10]
    svg = f"""<svg xmlns='http://www.w3.org/2000/svg' width='72' height='72'>
      <rect width='100%' height='100%' rx='14' ry='14' fill='#eef2ff'/>
      <text x='50%' y='53%' text-anchor='middle'
            font-family='-apple-system,system-ui,Segoe UI,Roboto,Helvetica,Arial'
            font-size='10' fill='#334155'>{text}</text>
    </svg>"""
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()

def must_read_text(path: Path, label: str) -> str:
    if not path.exists():
        st.error(f"Missing {label}: {path}")
        st.stop()
    try:
        return path.read_text(encoding="utf-8")
    except Exception as e:
        st.error(f"Failed reading {label}: {e}")
        st.stop()

TOKEN_WHITELIST = {
    "LOGO_JKN","HEADER_BADGE","AVATAR_IMG","CARD_ILLUSTR",
    "PRIMARY","PRIMARY_2","ACCENT","SUCCESS","TEXT","SUBTEXT",
    "CARD_BG","APP_BG","BORDER","TILES_HTML","NAV_HTML"
}

def replace_tokens_single_brace(html: str, mapping: dict) -> str:
    def repl(m):
        tok = m.group("tok")
        if tok in TOKEN_WHITELIST and tok in mapping:
            return str(mapping[tok])
        return m.group(0)
    pattern = re.compile(r"\{(?P<tok>[A-Z_]{2,})\}")
    return pattern.sub(repl, html)

def is_port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        return s.connect_ex((host, port)) != 0

# ---------- Sidebar status ----------
with st.sidebar:
    st.title("Template Status")
    st.write("Root:", str(ROOT))
    st.write("HTML exists:", HTML_PATH.exists())
    st.write("CSS exists:", CSS_PATH.exists())
    st.write("JS exists:", JS_PATH.exists())
    st.write("Assets dir exists:", ASSETS.exists())
    st.write("RAG chunks loaded:", len(RAG_CHUNKS))
    st.write("Embeddings precomputed:", len(RAG_EMBEDDINGS))
    
    # Add embedding model status
    st.subheader("Embedding Settings")
    
    # Test if model can load
    try:
        from sentence_transformers import SentenceTransformer
        model_status = "✅ sentence-transformers available"
        try:
            test_model = SentenceTransformer('all-MiniLM-L6-v2')
            model_status += " | Model loaded successfully"
        except Exception as e:
            model_status += f" | Model load failed: {e}"
    except ImportError:
        model_status = "❌ sentence-transformers not available"
    
    st.write(f"Package Status: {model_status}")
    
    if st.button("Reload Embedding Model"):
        embedding_model = None
        if RAG_CHUNKS:
            RAG_EMBEDDINGS = precompute_all_embeddings()
            st.success("Embeddings reloaded!")
        else:
            st.error("No RAG chunks available")

# ---------- Theme & assets ----------
PRIMARY, PRIMARY_2, ACCENT = "#0a84ff", "#1da1f2", "#DC3378"
SUCCESS, TEXT, SUBTEXT = "#22c55e", "#0f172a", "#475569"
CARD_BG, APP_BG, BORDER = "#ffffff", "#ffffff", "#e5e7eb"

HEADER_BADGE = data_uri(str(ASSETS / "badge165.jpg"), "165")
AVATAR_IMG   = data_uri(str(ASSETS / "avatar.jpg"), "Avatar")
CARD_ILLUSTR = data_uri(str(ASSETS / "antrian.jpg"), "Antrian")
LOGO_JKN     = data_uri(str(ASSETS / "logo_jkn_square.png"), "logo")

def build_tiles_html():
    features = [
        {"label": "Info Program\nJKN",       "img": data_uri(str(ASSETS/"infoprogram.png"),"Program")},
        {"label": "TELEHEALTH",              "img": data_uri(str(ASSETS/"telehealth.jpg"),"Tele")},
        {"label": "Info Riwayat\nPelayanan", "img": data_uri(str(ASSETS/"icarejkn.jpg"),"Riwayat")},
        {"label": "Bugar",                   "img": data_uri(str(ASSETS/"bugar.jpg"),"Bugar"), "new": True},
        {"label": "NEW Rehab\n(Cicilan)",    "img": data_uri(str(ASSETS/"rehab.jpg"),"Rehab"), "new": True},
        {"label": "Penambahan\nPeserta",     "img": data_uri(str(ASSETS/"registrasi.jpg"),"Daftar")},
        {"label": "Info Peserta",            "img": data_uri(str(ASSETS/"peserta.jpg"),"Peserta")},
        {"label": "SOS",                     "img": data_uri(str(ASSETS/"sos.jpg"),"SOS")},
        {"label": "Info Lokasi\nFaskes",     "img": data_uri(str(ASSETS/"faskes.jpg"),"Faskes")},
        {"label": "Perubahan\nData Peserta", "img": data_uri(str(ASSETS/"perubahan.jpg"),"Ubah"), "id": "perubahan"},
        {"label": "Pengaduan\nLayanan JKN",  "img": data_uri(str(ASSETS/"pengaduan.jpg"),"Aduan")},
        {"label": "Informasi Riwayat\nPembayaran", "img": data_uri(str(ASSETS/"informasi_riwayat_pembayaran.jpg"),"riwayat"), "id": "riwayat"},
    ]
    out = []
    for f in features:
        badge = "<div class='badge-new'>Baru</div>" if f.get("new") else ""
        data_id = f.get("id","")
        out.append(f"""<div class="tile" data-feature="{data_id}">
  <div class="icon-round">
    <img src="{f['img']}" alt="">
    {badge}
  </div>
  <div class="tile-label">{f['label']}</div>
</div>""")
    return "\n".join(out)

def build_nav_html():
    nav = [
        {"label":"Home",   "icon":data_uri(str(ASSETS/"nav_home.png"),"Home"),    "active":True},
        {"label":"Berita", "icon":data_uri(str(ASSETS/"nav_berita.png"),"Berita"),"active":False},
        {"label":"Kartu",  "icon":data_uri(str(ASSETS/"nav_kartu.png"),"Kartu"),  "active":False},
        {"label":"FAQ",    "icon":data_uri(str(ASSETS/"nav_faq.png"),"FAQ"),      "active":False},
        {"label":"Profil", "icon":data_uri(str(ASSETS/"nav_profil.png"),"Profil"),"active":False},
    ]
    out = []
    for n in nav:
        cls = "nav-item active" if n["active"] else "nav-item"
        out.append(f"""<a class="{cls}" href="#"><span class="ico"><img src="{n['icon']}" alt=""></span>{n['label']}</a>""")
    return "\n".join(out)

TILES_HTML = build_tiles_html()
NAV_HTML = build_nav_html()

# ---------- Load templates ----------
html_template = must_read_text(HTML_PATH, "HTML template")
css_text     = must_read_text(CSS_PATH,  "CSS file")
js_text      = must_read_text(JS_PATH,   "JS file")

# ---------- Replace the immediate "I heard you" with a real LLM call hook ----------
js_text = js_text.replace(
    'addChatBubble("Baik, saya mendengar Anda.", "bot");',
    'if (window._sendToLLM) { window._sendToLLM(transcript); } else { addChatBubble("Sebentar ya, saya proses…", "bot"); }'
)

# ---------- Inline CSS/JS into your HTML ----------
html_inline = html_template.replace(
    '<link rel="stylesheet" href="mobile_jkn.css"/>',
    f"<style>\n{css_text}\n</style>"
).replace(
    '<script src="mobile_jkn.js"></script>',
    f"<script>\n{js_text}\n</script>"
)

# ---------- Token replacements ----------
replacements = {
    "LOGO_JKN": LOGO_JKN,
    "HEADER_BADGE": HEADER_BADGE,
    "AVATAR_IMG": AVATAR_IMG,
    "CARD_ILLUSTR": CARD_ILLUSTR,
    "PRIMARY": PRIMARY,
    "PRIMARY_2": PRIMARY_2,
    "ACCENT": ACCENT,
    "SUCCESS": SUCCESS,
    "TEXT": TEXT,
    "SUBTEXT": SUBTEXT,
    "CARD_BG": CARD_BG,
    "APP_BG": APP_BG,
    "BORDER": BORDER,
    "TILES_HTML": TILES_HTML,
    "NAV_HTML": NAV_HTML,
}
final_html = replace_tokens_single_brace(html_inline, replacements)

# ---------- Hide Streamlit chrome ----------
st.markdown(dedent("""
<style>
  :root { color-scheme: only light; }
  [data-testid="stToolbar"], header, footer, #MainMenu { display: none !important; }
  [data-testid="stAppViewContainer"] { padding: 0 !important; background: #ffffff !important; }
  .block-container { padding: 0 !important; margin: 0 !important; max-width: 100% !important; }
  html, body { background: #ffffff !important; }
</style>
"""), unsafe_allow_html=True)

# ---------- API key input (kept in memory) ----------
with st.sidebar:
    st.subheader("LLM Settings")
    key_in = st.text_input("OpenRouter API Key", type="password", value=st.session_state.get("OPENROUTER_API_KEY",""))
    if key_in:
        st.session_state["OPENROUTER_API_KEY"] = key_in
    model_in = st.text_input("Model (OpenRouter)", value=st.session_state.get("OPENROUTER_MODEL","openai/gpt-4o-mini"))
    if model_in:
        st.session_state["OPENROUTER_MODEL"] = model_in

def get_api_key() -> str:
    return st.session_state.get("OPENROUTER_API_KEY") or os.getenv("OPENROUTER_API_KEY") or ""

def get_model() -> str:
    return st.session_state.get("OPENROUTER_MODEL") or os.getenv("OPENROUTER_MODEL") or "openai/gpt-4o-mini"

# ---------- Local relay (FastAPI) ----------
LLM_HOST = "127.0.0.1"
LLM_PORT = 7861
LLM_BASE = f"http://{LLM_HOST}:{LLM_PORT}"

_api = FastAPI()
_api.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)

def call_openrouter(prompt, history=None, model=None):
    history = history or []
    model = model or get_model()
    api_key = get_api_key()

    # ----- RAG RETRIEVAL -----
    rag_hits = retrieve_rag(prompt)
    
    # Check if we got any results
    if not rag_hits:
        rag_context = "Tidak ada informasi relevan ditemukan dalam dokumen."
    else:
        rag_context = "\n\n".join(
            f"[{c['file']}]\n{c['text']}"
            for c in rag_hits
        )

    # ----- ENHANCED SYSTEM PROMPT WITH SCENARIO AWARENESS -----
    system_prompt = f"""
Kamu adalah Asisten Pribadi JKN Wicara yang CERDAS dan INTERAKTIF.

INFORMASI RESMI BPJS:
{rag_context}

PERAN KAMU:
1. Asisten pribadi yang PINTAR bertanya untuk melengkapi informasi
2. JANGAN langsung buat antrean - tanya dulu informasi yang kurang
3. EKSTRAK informasi dari percakapan, tapi TANYA jika ada yang kurang
4. KONFIRMASI semua data sebelum membuat antrean
5. Hanya buat antrean setelah user konfirmasi "ya"

ALUR CERDAS:
1. User minta buat antrean → ANALISIS informasi yang ada
2. Jika ada yang kurang → TANYA informasi yang missing
3. Jika semua lengkap → KONFIRMASI semua data
4. User konfirmasi "ya" → BUAT antrean
5. User konfirmasi "tidak" → BATALKAN

CONTOH PERCAKAPAN YANG BENAR:
User: "Buatkan jadwal besok"
AI: "Baik, Bu! 👵 Saya akan bantu buatkan antrean untuk besok. ❓ Mau ke poli apa? Misalnya poli umum atau poli lainnya?"

User: "Poli umum"
AI: "❓ Keluhannya seperti apa, Bu? Bisa ceritakan gejala yang dirasakan?"

User: "Sakit kepala"
AI: "✅ **Konfirmasi Antrean:** 
🏥 Poli: Poli Umum  
📅 Tanggal: Besok
🤒 Keluhan: Sakit kepala

❓ Apakah sudah benar? Silakan konfirmasi 'ya' untuk buat antrean."

User: "Ya"
AI: "🔄 Membuat antrean... Mohon tunggu sebentar..."

ATURAN KETAT:
1. JANGAN langsung buat antrean tanpa konfirmasi
2. SELALU tanya informasi yang missing
3. SELALU konfirmasi sebelum action
4. Gunakan EMOJI untuk ramah
5. Untuk lansia, gunakan bahasa SANGAT SEDERHANA

INFORMASI YANG DIBUTUHKAN:
- Poli (umum, gigi, KIA, dll)
- Tanggal (hari ini, besok, lusa)  
- Keluhan (gejala sakit)
- Waktu (pagi, siang, sore - opsional)

TUGAS:
Jadilah asisten yang SABAR dan TELITI - tanya dulu, konfirmasi dulu, baru action.
"""
    payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": system_prompt},
        *history,
        {"role": "user", "content": prompt}
    ],
    "temperature": 0.1,  # Lower for more consistent automation
}

    try:
        r = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "http://localhost",
                "X-Title": "Mobile JKN Mock (RAG Edition)",
            },
            json=payload,
            timeout=60,
        )
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"].strip()

    except Exception as e:
        return f"Maaf, terjadi kendala: {e}"

@_api.post("/llm")
def llm_endpoint(payload: dict):
    if not get_api_key():
        return {"error": "missing OPENROUTER_API_KEY"}
    text = (payload.get("text") or "").strip()
    history = payload.get("history") or []
    model = payload.get("model") or None
    ui_state = payload.get("ui_state") or {}  # Get UI state from frontend
    
    if not text:
        return {"error": "empty text"}
    api_key = get_api_key()
    if not api_key:
        return {"error": "missing OPENROUTER_API_KEY"}
    
    # Add UI state context to the prompt
    ui_context = ""
    if ui_state:
        ui_context = f"\n\nKONTEKS UI SAAT INI:\n"
        if ui_state.get('hasActiveQueue'):
            ui_context += "- Ada antrean aktif yang terdeteksi\n"
        if ui_state.get('paymentScreenOpen'):
            ui_context += "- Layar riwayat pembayaran sedang terbuka\n"
        if ui_state.get('participantScreenOpen'):
            ui_context += "- Layar data peserta sedang terbuka\n"
    
    enhanced_text = text + ui_context
    reply = call_openrouter(enhanced_text, history=history, model=model)
    
    if reply.startswith("Maaf, terjadi kendala:"):
        return {"error": reply}
    return {"reply": reply}

def run_relay():
    uvicorn.run(_api, host=LLM_HOST, port=LLM_PORT, log_level="error")

if "api_started" not in st.session_state:
    if is_port_free(LLM_HOST, LLM_PORT):
        threading.Thread(target=run_relay, daemon=True).start()
    st.session_state["api_started"] = True


@_api.post("/tts")
def tts_endpoint(payload: dict):
    """
    JSON in:  {"text": "..."}
    Response: audio/wav bytes
    """
    try:
        text = (payload.get("text") or "").strip()
        if not text:
            # Return minimal silence
            silence = np.zeros(1600, dtype=np.float32)
            buf = io.BytesIO()
            sf.write(buf, silence, 16000, format="WAV")
            buf.seek(0)
            return Response(content=buf.read(), media_type="audio/wav")
        
        print(f"🔊 TTS generating: {text[:100]}...")
        wav, sr = get_numpy_waveform(text)
        
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV")
        buf.seek(0)
        audio_data = buf.read()
        
        print(f"🔊 TTS generated: {len(audio_data)} bytes")
        return Response(content=audio_data, media_type="audio/wav")
        
    except Exception as e:
        print(f"❌ TTS error: {e}")
        # Return minimal silence on error
        silence = np.zeros(1600, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, silence, 16000, format="WAV")
        buf.seek(0)
        return Response(content=buf.read(), media_type="audio/wav")


# ---------- Inject a tiny JS helper that calls the relay ----------
# Replace the llm_js_helper section with this:
llm_js_helper = f"""
<script>
window.OPENROUTER_API_KEY = '{get_api_key()}';
window.OPENROUTER_MODEL  = '{get_model()}';
window.LLM_BASE_URL      = '{LLM_BASE}';
window._llmHistory = window._llmHistory || [];

// Track if we have user interaction for autoplay
window._userInteracted = false;

// --- Improved TTS with better autoplay handling ---
window._speak = async function(text, bubbleElement = null) {{
  try {{
    const t = ("" + (text || "")).trim();
    if (!t || !window.LLM_BASE_URL) return;

    console.log('🔊 TTS requested:', t.substring(0, 50));
    
    // Update speaker icon to loading state
    if (bubbleElement) {{
      const speakerIcon = bubbleElement.querySelector('.speaker-icon');
      if (speakerIcon) {{
        speakerIcon.innerHTML = '⏳';
        speakerIcon.style.opacity = '1';
      }}
    }}
    
    const res = await fetch(window.LLM_BASE_URL + '/tts', {{
      method: 'POST',
      headers: {{ 'Content-Type': 'application/json' }},
      body: JSON.stringify({{ text: t }})
    }});
    
    if (!res.ok) {{
      console.warn('TTS request failed:', res.status);
      return;
    }}
    
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    
    // Store audio URL in bubble for replay
    if (bubbleElement) {{
      bubbleElement._audioUrl = url;
      bubbleElement._audioText = text;
    }}
    
    // Add event listeners for playback states
    audio.onplay = () => {{
      console.log('🔊 Audio started playing');
      if (bubbleElement) {{
        const speakerIcon = bubbleElement.querySelector('.speaker-icon');
        if (speakerIcon) {{
          speakerIcon.innerHTML = '🔊';
          speakerIcon.style.animation = 'pulse 1s infinite';
          speakerIcon.title = 'Sedang memutar...';
        }}
      }}
    }};
    
    audio.onended = () => {{
      console.log('🔊 Audio finished playing');
      if (bubbleElement) {{
        const speakerIcon = bubbleElement.querySelector('.speaker-icon');
        if (speakerIcon) {{
          speakerIcon.innerHTML = '🔈';
          speakerIcon.style.animation = 'none';
          speakerIcon.title = 'Klik untuk memutar ulang';
        }}
      }}
    }};
    
    audio.onerror = (e) => {{
      console.error('🔊 Audio play error:', e);
      if (bubbleElement) {{
        const speakerIcon = bubbleElement.querySelector('.speaker-icon');
        if (speakerIcon) {{
          speakerIcon.innerHTML = '❌';
          speakerIcon.style.animation = 'none';
          speakerIcon.title = 'Error memutar suara';
        }}
      }}
    }};
    
    // Try to play automatically only if user has interacted
    if (window._userInteracted) {{
      console.log('🔊 Attempting autoplay (user interacted)');
      const playPromise = audio.play();
      if (playPromise !== undefined) {{
        playPromise.then(() => {{
          console.log('🔊 Autoplay successful');
        }}).catch(error => {{
          console.log('🔊 Autoplay blocked, showing play state:', error);
          if (bubbleElement) {{
            const speakerIcon = bubbleElement.querySelector('.speaker-icon');
            if (speakerIcon) {{
              speakerIcon.innerHTML = '▶️';
              speakerIcon.title = 'Klik untuk memutar suara (autoplay diblokir)';
            }}
          }}
        }});
      }}
    }} else {{
      console.log('🔊 Autoplay skipped - no user interaction yet');
      if (bubbleElement) {{
        const speakerIcon = bubbleElement.querySelector('.speaker-icon');
        if (speakerIcon) {{
          speakerIcon.innerHTML = '▶️';
          speakerIcon.title = 'Klik untuk memutar suara (klik area chat dulu)';
        }}
      }}
    }}
    
    return audio;
  }} catch (e) {{
    console.warn('🔊 TTS failed:', e);
    if (bubbleElement) {{
      const speakerIcon = bubbleElement.querySelector('.speaker-icon');
      if (speakerIcon) {{
        speakerIcon.innerHTML = '❌';
        speakerIcon.title = 'Gagal memuat suara';
      }}
    }}
  }}
}};

// Add speaker icon to bot bubbles
function addSpeakerIcon(bubbleElement, text) {{
  const speakerIcon = document.createElement('div');
  speakerIcon.className = 'speaker-icon';
  speakerIcon.innerHTML = '🔈';
  speakerIcon.style.cssText = `
    position: absolute;
    bottom: 8px;
    right: 8px;
    cursor: pointer;
    font-size: 12px;
    opacity: 0.7;
    transition: all 0.2s;
    background: rgba(0,0,0,0.1);
    border-radius: 50%;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
  `;
  
  speakerIcon.title = 'Klik untuk memutar suara';
  
  speakerIcon.addEventListener('click', async (e) => {{
    e.stopPropagation();
    window._userInteracted = true; // Mark interaction for future autoplay
    
    const currentIcon = e.target.innerHTML;
    if (currentIcon === '🔊' || currentIcon === '⏳') return; // Already playing/loading
    
    if (bubbleElement._audioUrl) {{
      // Replay stored audio
      const audio = new Audio(bubbleElement._audioUrl);
      speakerIcon.innerHTML = '🔊';
      speakerIcon.style.animation = 'pulse 1s infinite';
      
      audio.play().catch(err => {{
        console.log('Replay failed:', err);
        speakerIcon.innerHTML = '❌';
        speakerIcon.style.animation = 'none';
      }});
      
      audio.onended = () => {{
        speakerIcon.innerHTML = '🔈';
        speakerIcon.style.animation = 'none';
      }};
    }} else {{
      // Generate new TTS
      speakerIcon.innerHTML = '⏳';
      await window._speak(text, bubbleElement);
    }}
  }});
  
  bubbleElement.style.position = 'relative';
  bubbleElement.appendChild(speakerIcon);
  return speakerIcon;
}};

// Add CSS for pulse animation and styles
const style = document.createElement('style');
style.textContent = `
  @keyframes pulse {{
    0% {{ opacity: 1; transform: scale(1); }}
    50% {{ opacity: 0.7; transform: scale(1.1); }}
    100% {{ opacity: 1; transform: scale(1); }}
  }}
  .speaker-icon:hover {{
    opacity: 1 !important;
    background: rgba(0,0,0,0.2) !important;
    transform: scale(1.1);
  }}
  .speaker-icon {{
    cursor: pointer !important;
  }}
`;
document.head.appendChild(style);

// Monkey-patch addChatBubble to auto-speak bot messages and add speaker icons
(function waitForAddChatBubble() {{
  if (typeof window.addChatBubble !== 'function') {{
    setTimeout(waitForAddChatBubble, 50);
    return;
  }}
  
  const _orig = window.addChatBubble;
  window.addChatBubble = function(text, sender) {{
    _orig(text, sender);
    
    if (sender === 'bot') {{
      console.log('🔊 Bot message detected for TTS:', text);
      
      // Find the latest bot bubble
      setTimeout(() => {{
        const chatContainer = document.querySelector('.chat-container') || 
                             document.querySelector('[class*="chat"]') || 
                             document.body;
        const bubbles = chatContainer.querySelectorAll('.chat-bubble.bot, .bubble.bot, [class*="bot-bubble"]');
        const latestBotBubble = bubbles[bubbles.length - 1];
        
        if (latestBotBubble) {{
          // Add speaker icon
          addSpeakerIcon(latestBotBubble, text);
          
          // Auto-speak after a short delay (only if user has interacted)
          setTimeout(() => {{
            if (window._userInteracted) {{
              console.log('🔊 Auto-speaking bot message');
              window._speak(text, latestBotBubble);
            }} else {{
              console.log('🔊 Skipping autoplay - waiting for user interaction');
              const speakerIcon = latestBotBubble.querySelector('.speaker-icon');
              if (speakerIcon) {{
                speakerIcon.innerHTML = '▶️';
                speakerIcon.title = 'Klik untuk memutar suara (klik area chat dulu)';
              }}
            }}
          }}, 800);
        }}
      }}, 100);
    }}
  }};
}})();

// Existing LLM function
window._sendToLLM = async function(userText) {{
  await sendToLLMWithActions(userText);
}};

// Mark user interaction for autoplay on any click/touch in the app
function markUserInteraction() {{
  if (!window._userInteracted) {{
    window._userInteracted = true;
    console.log('🔊 User interaction detected - autoplay enabled');
    
    // Try to play any pending bot messages
    const bubbles = document.querySelectorAll('.chat-bubble.bot, .bubble.bot, [class*="bot-bubble"]');
    bubbles.forEach(bubble => {{
      const speakerIcon = bubble.querySelector('.speaker-icon');
      if (speakerIcon && speakerIcon.innerHTML === '▶️') {{
        const text = bubble._audioText || bubble.textContent || bubble.innerText;
        console.log('🔊 Playing pending message:', text.substring(0, 50));
        window._speak(text, bubble);
      }}
    }});
  }}
}}

// Listen for user interactions
document.addEventListener('click', markUserInteraction);
document.addEventListener('touchstart', markUserInteraction);
document.addEventListener('keydown', markUserInteraction);

// Also mark interaction when sending messages
const originalSendToLLM = window._sendToLLM;
window._sendToLLM = async function(userText) {{
  markUserInteraction();
  return await originalSendToLLM(userText);
}};

console.log('🔊 Enhanced TTS system initialized - click anywhere to enable autoplay');
</script>
"""

final_html = final_html.replace("</body>", llm_js_helper + "\n</body>")

# ---------- Render ----------
st.sidebar.write("HTML length:", len(final_html))
if not final_html.strip():
    st.error("Final HTML is empty.")
else:
    try:
        st.components.v1.html(final_html, height=750, scrolling=False)
    except Exception as e:
        st.error(f"HTML render error: {e}")
        st.text_area("Final HTML", final_html, height=300)