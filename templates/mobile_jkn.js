/* ---------- Utility: Pad + Format date ---------- */
function pad(n) { return n < 10 ? "0" + n : n; }
function fmt(d) { return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear(); }

/* ---------- STATE ---------- */
let currentQueue = null;
const LLM_API = "http://127.0.0.1:7861/llm";
let chatHistory = [];
let recognition = null;
let isListening = false;
let liveBubble = null;
let hasSpokenOnce = false;
let lastTranscript = "";
let lastFinalTime = 0;

// Queue creation state
let queueCreationState = {
  isCreatingQueue: false,
  currentStep: null,
  collectedData: {},
  missingFields: [],
  awaitingConfirmation: false
};

let actionLock = false;
async function runActionSequence(actions, params = {}) {
  if (!actions || actions.length === 0) return;
  if (actionLock) return; // debounce parallel runs
  actionLock = true;

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    addChatBubble(`🧭 Langkah ${i + 1}/${actions.length}: ${a.replaceAll('_',' ')}`, "bot");
    // small pause to let user read the step label
    await new Promise(r => setTimeout(r, 400));
    const res = await performUIAction(a, params);
    if (res) {
      addChatBubble(res, "bot");
      chatHistory.push({ role: "assistant", content: res });
    }
    // pacing between steps
    await new Promise(r => setTimeout(r, 600));
  }

  actionLock = false;
}

/* ---------- Populate date dropdown ---------- */
function populateTanggal() {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const sel = document.getElementById("tanggalSelect");
  if (!sel) return;
  sel.innerHTML = "";
  sel.append(new Option(`Hari ini (${fmt(today)})`, "HARI_INI"));
  sel.append(new Option(`Besok (${fmt(tomorrow)})`, "BESOK"));
}

function addChatBubble(text, sender="user") {
  const chatArea = document.getElementById("chatArea");
  if (!chatArea) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + sender;
  bubble.textContent = text;
  chatArea.appendChild(bubble);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/* ---------- UI EXPLORATION FUNCTIONS ---------- */
// UPDATED: read-and-summarize the payment screen (also highlights the latest tx)
function explorePaymentScreen() {
    const paymentScreen = document.getElementById('paymentScreen');
    if (!paymentScreen || paymentScreen.classList.contains('hidden')) {
      return "🔍 Layar pembayaran belum terbuka.";
    }
  
    const payCards = document.querySelectorAll('.pay-card');
    if (!payCards || payCards.length === 0) {
      return "📋 Tidak ada data riwayat pembayaran yang dapat dibaca.";
    }
  
    // Parse all cards
    const items = [];
    payCards.forEach(card => {
      const header = card.querySelector('.pay-card-header')?.textContent?.trim() || 'Peserta';
      const rows = card.querySelectorAll('.pay-row');
      const info = { peserta: header };
  
      rows.forEach(row => {
        const label = row.querySelector('.pay-label span:last-child')?.textContent?.trim() || '';
        const value = row.querySelector('.pay-value')?.textContent?.trim() || '';
        if (/pembayaran/i.test(label)) info.amount = value;
        else if (/channel/i.test(label)) info.channel = value;
        else if (/tgl bayar/i.test(label)) info.date = value;
        else if (/status/i.test(label)) info.status = value;
      });
  
      items.push(info);
    });
  
    // Assume first card is the most recent (UI already sorted desc)
    const latest = items[0];
    let summary = "📋 **Ringkasan Riwayat Pembayaran:**\n";
    if (latest) {
      summary += `\n**Terakhir Dibayar:**\n- Tanggal: ${latest.date || '-'}\n- Jumlah: ${latest.amount || '-'}\n- Channel: ${latest.channel || '-'}\n- Status: ${latest.status || '-'}\n`;
    }
  
    // Also provide compact list of recent items
    summary += "\n**Transaksi Lainnya:**";
    items.slice(1).forEach((tx, idx) => {
      summary += `\n${idx + 1}. ${tx.date || '-'} • ${tx.amount || '-'} • ${tx.status || '-'}`;
    });
  
    return summary.trim();
  }
  

function exploreParticipantScreen() {
  const participantScreen = document.getElementById('participantScreen');
  if (!participantScreen || participantScreen.classList.contains('hidden')) {
    return "🔍 Layar peserta belum terbuka.";
  }
  let summary = "📋 **Data Peserta:**\n";
  const kisFaskes = document.getElementById('kisFaskesText')?.textContent;
  const participantFaskes = document.getElementById('participantFaskesText')?.textContent;
  if (kisFaskes) summary += `\n**Faskes TK1 Aktif:** ${kisFaskes}\n`;
  if (participantFaskes) summary += `\n**Faskes Terdaftar (Perubahan Data Peserta):** ${participantFaskes}\n`;

  const dataSections = document.querySelectorAll('.data-section');
  dataSections.forEach(section => {
    const label = section.querySelector('.data-label')?.textContent;
    const value = section.querySelector('.data-main-text')?.textContent?.split('\n')[0];
    if (label && value) summary += `\n**${label}:** ${value}`;
  });
  return summary;
}

// UPDATED: make sure ticket number is read from the correct selector
function exploreActiveQueue() {
    const ticketView = document.getElementById('ticketView');
    const hasActiveQueue = ticketView && !ticketView.classList.contains('hidden');
    if (!hasActiveQueue) return "📋 **Status Antrean:** Tidak ada antrean aktif saat ini.";
  
    let summary = "📋 **Antrean Aktif:**\n";
    const elements = {
      'Faskes': 'ticketFaskesName',
      'Poli': 'ticketPoli',
      'Tanggal': 'ticketTanggal',
      'Keluhan': 'ticketKeluhan',
      'Tenaga Medis': 'ticketDokter',
      'Jadwal': 'ticketJam',
      'Sisa Antrean': 'ticketSisa'
    };
    for (const [label, id] of Object.entries(elements)) {
      const element = document.getElementById(id);
      if (element) summary += `\n**${label}:** ${element.textContent || '-'}`;
    }
  
    // Nomor antrean memakai CLASS .ticket-number (bukan id)
    const ticketNumberEl = document.querySelector('.ticket-number');
    if (ticketNumberEl) {
      summary += `\n**Nomor Antrean:** ${ticketNumberEl.textContent.trim()}`;
    }
  
    return summary;
  }
  

/* ---------- QUEUE CREATION AUTOMATION ---------- */
function autoFillQueueForm(queueData) {
  console.log("Auto-filling queue form with data:", queueData);

  // Poli
  if (document.getElementById('poliSelect')) {
    const poliSelect = document.getElementById('poliSelect');
    if (queueData.poli) {
      const options = Array.from(poliSelect.options).map(o => o.text.toLowerCase());
      const idx = options.findIndex(t => t.includes(queueData.poli.toLowerCase()));
      poliSelect.selectedIndex = idx !== -1 ? idx : 0;
    } else {
      poliSelect.selectedIndex = 0;
    }
  }

  // Tanggal (default besok if not mapped)
  if (document.getElementById('tanggalSelect')) {
    const tanggalSelect = document.getElementById('tanggalSelect');
    const options = Array.from(tanggalSelect.options).map(o => o.text.toLowerCase());
    const mapping = { 'hari ini': 'hari ini', 'besok': 'besok', 'lusa': 'besok', 'sekarang': 'hari ini' };
    const key = (queueData.tanggal || '').toLowerCase();
    const target = mapping[key] || 'besok';
    const idx = options.findIndex(t => t.includes(target));
    tanggalSelect.selectedIndex = idx !== -1 ? idx : 1;
  }

  // Keluhan
  const keluhanInput = document.getElementById('keluhanInput');
  if (keluhanInput) keluhanInput.value = queueData.keluhan || "Konsultasi kesehatan umum";

  // Pilih dokter pertama + submit
  setTimeout(() => {
    const firstDoctorCard = document.querySelector('.doctor-card');
    if (firstDoctorCard) {
      firstDoctorCard.click();
      console.log("Auto-selected first available doctor");
      setTimeout(() => {
        if (document.getElementById('saveButton')) {
          document.getElementById('saveButton').click();
          console.log("Auto-submitted queue form");
        }
      }, 500);
    }
  }, 800);
}

function extractQueueDataFromText(text) {
  const data = {};
  const t = (text || "").toLowerCase();

  // Poli keywords
  const poliKeywords = {
    'dokter gigi': 'Poli Gigi & Mulut',
    'gigi': 'Poli Gigi & Mulut',
    'dokter umum': 'Poli Umum',
    'umum': 'Poli Umum',
    'kia': 'Poli KIA',
    'kb': 'Poli KB',
    'laboratorium': 'Laboratorium'
  };
  for (const [key, value] of Object.entries(poliKeywords)) {
    if (t.includes(key)) { data.poli = value; break; }
  }

  // Tanggal
  if (t.includes('besok')) data.tanggal = 'besok';
  else if (t.includes('lusa')) data.tanggal = 'lusa';
  else if (t.includes('hari ini') || t.includes('sekarang')) data.tanggal = 'hari ini';

  // Waktu
  if (t.includes('pagi')) data.waktu = 'pagi';
  else if (t.includes('siang')) data.waktu = 'siang';
  else if (t.includes('sore')) data.waktu = 'sore';

  // Keluhan (collect multiple then join)
  const keluhanDict = {
    'sakit gigi': 'Sakit gigi',
    'sakit kepala': 'Sakit kepala',
    'demam': 'Demam',
    'batuk': 'Batuk',
    'pilek': 'Pilek',
    'pusing': 'Pusing',
    'mual': 'Mual',
    'diare': 'Diare',
    'sesak': 'Sesak napas',
    'nyeri': 'Nyeri badan',
    'lemas': 'Badan lemas',
    'kurang enak badan': 'Kurang enak badan'
  };
  const found = [];
  for (const [k, v] of Object.entries(keluhanDict)) {
    if (t.includes(k)) found.push(v);
  }
  if (found.length) data.keluhan = Array.from(new Set(found)).join(', ');

  console.log("Extracted queue data:", data);
  return data;
}

function buildConfirmationMessage(queueData) {
  let message = "✅ **Konfirmasi Antrean:**\n";
  if (queueData.poli) message += `🏥 **Poli:** ${queueData.poli}\n`;
  if (queueData.tanggal) message += `📅 **Tanggal:** ${queueData.tanggal}\n`;
  if (queueData.waktu) message += `🕒 **Waktu:** ${queueData.waktu}\n`;
  if (queueData.keluhan) message += `🤒 **Keluhan:** ${queueData.keluhan}\n`;
  message += "\n❓ Apakah sudah benar? Silakan konfirmasi 'ya' untuk buat antrean.";
  return message;
}

function analyzeMissingQueueData(userText) {
  const extractedData = extractQueueDataFromText(userText);
  const missingFields = [];
  if (!extractedData.poli) missingFields.push('poli');
  if (!extractedData.tanggal) missingFields.push('tanggal');
  if (!extractedData.keluhan) missingFields.push('keluhan');
  if (!extractedData.waktu) missingFields.push('waktu');
  return { extractedData, missingFields, isComplete: missingFields.length === 0 };
}

function getQuestionForMissingField(field) {
  const questions = {
    'poli': "❓ Mau ke poli apa, Bu? Misalnya poli umum, poli gigi, atau poli lainnya?",
    'tanggal': "❓ Kapan mau berobatnya? Hari ini, besok, atau lusa?",
    'keluhan': "❓ Keluhannya seperti apa, Bu? Bisa ceritakan gejala yang dirasakan?",
    'waktu': "❓ Jam berapa lebih nyaman? Pagi, siang, atau sore?"
  };
  return questions[field] || "❓ Bisa beri tahu informasi tambahannya?";
}

/* ---------- ENHANCED QUEUE CREATION EXECUTION ---------- */
function executeQueueCreation() {
  console.log("🚀 EXECUTING QUEUE CREATION:", queueCreationState.collectedData);
  return new Promise((resolve) => {
    // staged visualization
    showModal(new Event('click'));
    addChatBubble("🗂 Membuka formulir antrean…", "bot");

    setTimeout(() => {
      openFaskes(new Event('click'));
      addChatBubble("🏥 Membuka halaman faskes & formulir…", "bot");

      setTimeout(() => {
        autoFillQueueForm(queueCreationState.collectedData);
        addChatBubble("✍️ Mengisi formulir & memilih dokter…", "bot");

        setTimeout(() => {
          const ticketInfo = exploreActiveQueue();
          let resultMessage = "";
          if (!ticketInfo.includes('Tidak ada antrean aktif')) {
            resultMessage = "✅ **Antrean Berhasil Dibuat!**\n" + ticketInfo;
            console.log("🎉 QUEUE CREATION SUCCESS");
          } else {
            resultMessage = "❌ Gagal membuat antrean. Silakan coba lagi.";
            console.log("❌ QUEUE CREATION FAILED");
          }

          // Reset state
          queueCreationState = {
            isCreatingQueue: false,
            currentStep: null,
            collectedData: {},
            missingFields: [],
            awaitingConfirmation: false
          };

          setTimeout(() => {
            closeFaskes(new Event('click'));
            closeModal();
            resolve(resultMessage);
          }, 800);

        }, 1600);
      }, 600);
    }, 200);
  });
}

// NEW: normalize noisy STT text before intent parsing
function normalizeSTT(s) {
    let t = (s || "").toLowerCase().trim();
  
    // Unify common variants
    t = t.replace(/\bantrian\b/g, 'antrean');   // standardize spelling
    t = t.replace(/\bjadwal\s*kaskus\b/g, 'jadwal faskes');
    t = t.replace(/\bjadwal\s*kasus\b/g, 'jadwal faskes');
  
    // Very short/ambiguous fragments → assume "cek"
    if (/^cek\s*(si|saja|nih|dong)?$/.test(t)) t = 'cek jadwal';
  
    return t;
  }

/* ---------- INTENT → ACTIONS (fixed priority order to avoid duplicates) ---------- */
// UPDATED: tighter & reordered intent rules (SK2 wins over SK4), uses normalizeSTT()
function parseActionsFromUserIntent(userText) {
    const actions = [];
    const userTextLower = normalizeSTT(userText || "");
  
    // 1) If waiting for confirmation, handle immediately
    if (queueCreationState.awaitingConfirmation) {
      if (/\b(ya|iya|betul|benar|oke|ok|setuju|sip|baik|tolong|buatkan|buat|yes|y)\b/i.test(userTextLower)) {
        actions.push('execute_queue_creation');
        return actions;
      } else if (/\b(tidak|bukan|salah|ubah|ganti|batal)\b/i.test(userTextLower)) {
        actions.push('cancel_queue_creation');
        return actions;
      }
      actions.push('confirm_queue_creation');
      return actions;
    }
  
    // 2) If currently collecting data, treat input as filling next fields
    if (queueCreationState.isCreatingQueue && queueCreationState.currentStep) {
      const newData = extractQueueDataFromText(userTextLower);
      Object.assign(queueCreationState.collectedData, newData);
      queueCreationState.missingFields = queueCreationState.missingFields.filter(f => !newData[f]);
  
      if (queueCreationState.missingFields.length === 0) {
        queueCreationState.awaitingConfirmation = true;
        queueCreationState.currentStep = null;
        actions.push('confirm_queue_creation');
      } else {
        const nextField = queueCreationState.missingFields[0];
        queueCreationState.currentStep = nextField;
        actions.push(`ask_${nextField}`);
      }
      return actions;
    }
  
    // ---------- SCENARIO DETECTION (order matters) ----------
  
    // A) Payment history / iuran
    if (/riwayat pembayaran|cek pembayaran|tagihan|pembayaran saya|iuran|sudah bayar|lunas/i.test(userTextLower)) {
      actions.push('open_payment_screen');
      return actions;
    }
  
    // B) Check active queue / schedule (SKENARIO 2) — broaden patterns & day words
    const dayWords = "(hari ini|besok|lusa|senin|selasa|rabu|kamis|jumat|sabtu|minggu)";
    const checkBookingRe = new RegExp(
      `(\\bcek\\s*(jadwal|booking|antre?an)\\b)|` +       // cek jadwal / cek booking / cek antrian
      `(\\bcek\\s*${dayWords}\\b)|` +                      // cek senin / cek besok / cek lusa
      `(\\bjadwal\\s*(saya|kontrol|${dayWords})\\b)|` +    // jadwal saya/kontrol/besok/dll
      `(pengingat\\s*kontrol)|` +                          // pengingat kontrol
      `(jadwal\\s*(faskes|kaskus|kasus))`,                 // typo STT umum
      "i"
    );
    if (checkBookingRe.test(userTextLower)) {
      actions.push('check_active_queue');
      return actions;
    }
  
    // C) Participant / change faskes
    if (/ubah faskes|ganti faskes|pindah faskes|faskes tingkat satu|faskes tk1|faskes saya di mana/i.test(userTextLower)) {
      actions.push('open_participant_screen');
      return actions;
    }
  
    // D) Create queue (SKENARIO 4) — restricted to ACTION verbs
    const createQueueRe = /(buat(kan)?|daftar(kan)?|ambil|mendaftar|pendamping\s*rujukan)/i;
  
    // “jadwal” only triggers SK4 if paired with an action verb
    if (createQueueRe.test(userTextLower) ||
        (/\bjadwal\b/i.test(userTextLower) && /\b(buat|buatkan|daftar|ambil)\b/i.test(userTextLower))) {
  
      const analysis = analyzeMissingQueueData(userTextLower);
      if (analysis.isComplete) {
        queueCreationState.collectedData = analysis.extractedData;
        queueCreationState.awaitingConfirmation = true;
        queueCreationState.isCreatingQueue = true;
        queueCreationState.currentStep = null;
        queueCreationState.missingFields = [];
        actions.push('confirm_queue_creation');
      } else {
        queueCreationState = {
          isCreatingQueue: true,
          currentStep: analysis.missingFields[0],
          collectedData: analysis.extractedData,
          missingFields: analysis.missingFields,
          awaitingConfirmation: false
        };
        actions.push('start_queue_creation');
      }
      return actions;
    }
  
    // Default: no action
    return actions;
  }
  

/* ---------- AGENTIC UI ACTIONS ---------- */
// UPDATED: performUIAction — make payment & participant flows "seamless" (returns the read summary, not just "opening...")

/* ---------- AGENTIC UI ACTIONS ---------- */
async function performUIAction(action, params = {}) {
    switch(action) {
      case 'start_queue_creation': {
        const firstMissing = queueCreationState.missingFields[0];
        return getQuestionForMissingField(firstMissing);
      }
      case 'ask_poli':      return getQuestionForMissingField('poli');
      case 'ask_tanggal':   return getQuestionForMissingField('tanggal');
      case 'ask_keluhan':   return getQuestionForMissingField('keluhan');
      case 'ask_waktu':     return getQuestionForMissingField('waktu');
      case 'confirm_queue_creation':
        return buildConfirmationMessage(queueCreationState.collectedData);
  
      case 'execute_queue_creation': {
        const result = await executeQueueCreation();
        return result;
      }
  
      case 'cancel_queue_creation':
        queueCreationState = {
          isCreatingQueue: false,
          currentStep: null,
          collectedData: {},
          missingFields: [],
          awaitingConfirmation: false
        };
        return "❌ Pembuatan antrean dibatalkan. Ada yang bisa saya bantu lagi?";
  
      case 'open_payment_screen': {
        const tile = document.querySelector('.tile[data-feature="riwayat"]');
        if (!tile) return "⚠️ Tile riwayat pembayaran tidak ditemukan.";
        tile.click();
        await new Promise(r => setTimeout(r, 350));
        const s = explorePaymentScreen();
        return "💰 Membuka layar Riwayat Pembayaran...\n\n" + s;
      }
  
      case 'open_participant_screen': {
        const tile = document.querySelector('.tile[data-feature="perubahan"]');
        if (!tile) return "⚠️ Tile perubahan data peserta tidak ditemukan.";
        tile.click();
        await new Promise(r => setTimeout(r, 350));
        const s = exploreParticipantScreen();
        return "👤 Membuka layar Data Peserta…\n\n" + s;
      }
  
      case 'check_active_queue': {
        const queueInfo = exploreActiveQueue();
        if (queueInfo.includes('Tidak ada antrean aktif')) {
          return "📋 **Status Antrean:**\nSaat ini Anda belum memiliki antrean aktif.\n\n💡 Ingin membuat antrean baru?";
        } else {
          return queueInfo + "\n\n❓ Ada yang bisa saya bantu terkait antrean ini?";
        }
      }
  
      default:
        return "";
    }
  }

  /* ---------- LLM COMMUNICATION (SINGLE BUBBLE RESPONSE) ---------- */
async function sendToLLMWithActions(text) {
    // Add user message to chat
    addChatBubble(text, "user");
    chatHistory.push({role: "user", content: text});
  
    // Check for actions first
    const userActions = parseActionsFromUserIntent(text);
    console.log("🔍 Checking for actions:", userActions);
    
    // If we have actions, execute them directly without LLM
    if (userActions.length > 0) {
      console.log("🎯 Executing actions directly:", userActions);
      await executeActionSequence(userActions, text);
      return;
    }
  
    // Only use LLM if no actions detected
    console.log("🤖 No actions found, using LLM");
    try {
      const apiKey = window.OPENROUTER_API_KEY;
      const model = window.OPENROUTER_MODEL || "openai/gpt-4o-mini";
      const llmBase = window.LLM_BASE_URL || "http://127.0.0.1:7861";
  
      if (!apiKey) {
        addChatBubble("Maaf, API key tidak ditemukan. Silakan periksa pengaturan.", "bot");
        return;
      }
  
      const uiState = {
        hasActiveQueue: document.getElementById('ticketView') && 
          !document.getElementById('ticketView').classList.contains('hidden'),
        paymentScreenOpen: document.getElementById('paymentScreen') && 
          !document.getElementById('paymentScreen').classList.contains('hidden'),
        participantScreenOpen: document.getElementById('participantScreen') && 
          !document.getElementById('participantScreen').classList.contains('hidden')
      };
  
      const res = await fetch(`${llmBase}/llm`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({
          text,
          history: chatHistory,
          model,
          api_key: apiKey,
          ui_state: uiState
        })
      });
  
      const data = await res.json();
  
      if (data.error) {
        addChatBubble("Maaf, terjadi kendala: " + data.error, "bot");
        return;
      }
  
      const reply = (data.reply || "").trim();
      if (reply) {
        addChatBubble(reply, "bot");
        chatHistory.push({role:"assistant", content: reply});
      }
  
    } catch (e) {
      addChatBubble("Jaringan bermasalah: " + e.message, "bot");
    }
  }
  
  /* ---------- EXECUTE ACTIONS (NO EXTRA BUBBLES) ---------- */
  async function executeActionSequence(actions, userText) {
    if (!actions || actions.length === 0) return;
    if (actionLock) return;
    actionLock = true;
  
    let finalResponse = "";
  
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.log(`Executing action ${i + 1}/${actions.length}:`, action);
      
      const result = await performUIAction(action, { userText });
      
      if (result) {
        // For the last action, use its result as the final response
        if (i === actions.length - 1) {
          finalResponse = result;
        }
      }
      
      // Small delay between actions
      await new Promise(r => setTimeout(r, 400));
    }
  
    // Send only ONE final response bubble
    if (finalResponse) {
      addChatBubble(finalResponse, "bot");
      chatHistory.push({role: "assistant", content: finalResponse});
    }
  
    actionLock = false;
  }

/* ---------- Queue, Faskes, and Doctor Modals ---------- */
function showModal(event) {
  event.preventDefault();
  document.getElementById("queueModal").classList.add("show");
}
function closeModal() {
  document.getElementById("queueModal").classList.remove("show");
}
function openFaskes(event) {
  event.preventDefault();
  document.getElementById("queueModal").classList.remove("show");
  const fm = document.getElementById("faskesModal");
  fm.classList.add("show");

  const formView = document.getElementById("formView");
  const ticketView = document.getElementById("ticketView");
  if (currentQueue) {
    formView.classList.add("hidden");
    ticketView.classList.remove("hidden");
  } else {
    formView.classList.remove("hidden");
    ticketView.classList.add("hidden");
  }
}
function closeFaskes(event) {
  event.preventDefault();
  document.getElementById("faskesModal").classList.remove("show");
}
function openDoctorModal(event) {
  event.preventDefault();
  document.getElementById("doctorModal").classList.add("show");
  randomizeDoctorStats();
}
function closeDoctorModal(event) {
  if (event) event.preventDefault();
  document.getElementById("doctorModal").classList.remove("show");
}
function randomizeDoctorStats() {
  const max = 30;
  document.querySelectorAll("#doctorModal .doc-card").forEach(card => {
    const taken = Math.floor(Math.random() * (max + 1));
    const left = Math.max(0, max - taken);
    card.querySelector(".ambil").textContent = taken;
    card.querySelector(".sisa").textContent = left;
    card.querySelector(".panggil").textContent = 0;
  });
}
function selectDoctor(name, jam) {
  const box = document.getElementById("tenagaBox");
  if (box) {
    box.innerHTML = `${name} — ${jam}<span class="dropdown">▾</span>`;
  }
  closeDoctorModal();
}

function handleSave(event) {
  if (event) event.preventDefault();

  const poliSel = document.getElementById("poliSelect");
  const poli = poliSel ? poliSel.value : "Poli Umum";

  const tglSel = document.getElementById("tanggalSelect");
  let tanggalLabel = "";
  if (tglSel && tglSel.selectedIndex >= 0) {
    tanggalLabel = tglSel.options[tglSel.selectedIndex].text;
  }

  const tenBox = document.getElementById("tenagaBox");
  const tenagaText = tenBox ? tenBox.textContent.replace("▾","").trim() : "-";

  const keluhanEl = document.getElementById("keluhanInput");
  const keluhan = keluhanEl ? keluhanEl.value.trim() : "";

  currentQueue = {
    poli,
    tanggalLabel,
    tenagaText,
    keluhan,
    nomor: "A001",
    sisa: 1
  };

  document.getElementById("ticketPoli").textContent = poli;
  document.getElementById("ticketTanggal").textContent = tanggalLabel || "-";
  document.getElementById("ticketKeluhan").textContent = keluhan || "-";

  const dokSplit = tenagaText.split("—");
  if (dokSplit.length >= 2) {
    document.getElementById("ticketDokter").textContent = dokSplit[0].trim();
    document.getElementById("ticketJam").textContent = dokSplit[1].trim();
  } else {
    document.getElementById("ticketDokter").textContent = tenagaText || "-";
  }

  document.getElementById("ticketSisa").textContent = currentQueue.sisa;
  document.getElementById("ticketDilayani").textContent = "-";

  document.getElementById("formView").classList.add("hidden");
  document.getElementById("ticketView").classList.remove("hidden");
}

function cancelQueue() {
  currentQueue = null;

  const keluhanEl = document.getElementById("keluhanInput");
  if (keluhanEl) keluhanEl.value = "";

  const tenBox = document.getElementById("tenagaBox");
  if (tenBox) {
    tenBox.innerHTML = 'Pilih Tenaga Medis<span class="dropdown">▾</span>';
  }

  document.getElementById("ticketView").classList.add("hidden");
  document.getElementById("formView").classList.remove("hidden");
}

/* ---------- Data Faskes (mock) ---------- */
const FASKES_DATA = {
  "DKI Jakarta": {
    "Jakarta Barat": [
      { id: "irfani", name: "KLINIK PRATAMA IRFANI", address: "JALAN KEMANGGISAN RAYA BLOK B3", phone: "0812-10045504" },
      { id: "kebonjeruk", name: "PUSKESMAS KEBON JERUK", address: "JL. RAYA KEBON JERUK NO. 12", phone: "021-5550000" }
    ]
  },
  "Sulawesi Utara": {
    "Manado": [
      { id: "paniki", name: "PUSKESMAS PANIKI", address: "JL. PANIKI RAYA", phone: "0431-123456" }
    ]
  }
};

/* default faskes */
let currentFaskes = FASKES_DATA["DKI Jakarta"]["Jakarta Barat"][0];

function populateProvinsiOptions() {
  const provSel   = document.getElementById("provinsiSelect");
  const kotaSel   = document.getElementById("kotaSelect");
  const faskesSel = document.getElementById("faskesSelectChange");
  if (!provSel || !kotaSel || !faskesSel) return;

  provSel.innerHTML = '<option value="">Pilih Provinsi</option>';
  Object.keys(FASKES_DATA).forEach(p => {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    provSel.appendChild(opt);
  });

  kotaSel.innerHTML   = '<option value="">Pilih Kota / Kabupaten</option>';
  faskesSel.innerHTML = '<option value="">Pilih Fasilitas Kesehatan</option>';
}

function populateKotaOptions() {
  const provSel   = document.getElementById("provinsiSelect");
  const kotaSel   = document.getElementById("kotaSelect");
  const faskesSel = document.getElementById("faskesSelectChange");
  if (!provSel || !kotaSel || !faskesSel) return;

  const prov = provSel.value;
  kotaSel.innerHTML   = '<option value="">Pilih Kota / Kabupaten</option>';
  faskesSel.innerHTML = '<option value="">Pilih Fasilitas Kesehatan</option>';

  if (!prov || !FASKES_DATA[prov]) return;

  Object.keys(FASKES_DATA[prov]).forEach(kota => {
    const opt = document.createElement("option");
    opt.value = kota;
    opt.textContent = kota;
    kotaSel.appendChild(opt);
  });
}

function populateFaskesOptions() {
  const provSel   = document.getElementById("provinsiSelect");
  const kotaSel   = document.getElementById("kotaSelect");
  const faskesSel = document.getElementById("faskesSelectChange");
  if (!provSel || !kotaSel || !faskesSel) return;

  const prov = provSel.value;
  const kota = kotaSel.value;
  faskesSel.innerHTML = '<option value="">Pilih Fasilitas Kesehatan</option>';

  if (!prov || !kota || !FASKES_DATA[prov] || !FASKES_DATA[prov][kota]) return;

  FASKES_DATA[prov][kota].forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name;
    faskesSel.appendChild(opt);
  });
}

function openChangeFaskes(e) {
  if (e) e.preventDefault();
  const modal = document.getElementById("changeFaskesModal");
  if (!modal) return;
  modal.classList.add("show");
  populateProvinsiOptions();
}

function closeChangeFaskes(e) {
  if (e) e.preventDefault();
  const modal = document.getElementById("changeFaskesModal");
  if (modal) modal.classList.remove("show");
}

function applyFaskesChange(e) {
  if (e) e.preventDefault();

  const provSel   = document.getElementById("provinsiSelect");
  const kotaSel   = document.getElementById("kotaSelect");
  const faskesSel = document.getElementById("faskesSelectChange");

  if (!provSel || !kotaSel || !faskesSel) return;

  const prov = provSel.value;
  const kota = kotaSel.value;
  const fId  = faskesSel.value;

  if (!prov || !kota || !fId) {
    alert("Silakan pilih provinsi, kota/kabupaten, dan fasilitas kesehatan.");
    return;
  }

  const list   = (FASKES_DATA[prov] || {})[kota] || [];
  const chosen = list.find(f => f.id === fId);
  if (!chosen) return;

  currentFaskes = chosen;

  const kisText = document.getElementById("kisFaskesText");
  if (kisText) kisText.textContent = chosen.name;

  const partText = document.getElementById("participantFaskesText");
  if (partText) partText.textContent = chosen.name;

  const partUpdate = document.getElementById("participantFaskesUpdate");
  if (partUpdate) {
    const now = new Date();
    partUpdate.textContent = "Update : " + fmt(now);
  }

  const qName  = document.getElementById("queueFaskesName");
  const qAddr  = document.getElementById("queueFaskesAddress");
  const qPhone = document.getElementById("queueFaskesPhone");
  if (qName)  qName.textContent  = chosen.name;
  if (qAddr)  qAddr.textContent  = chosen.address;
  if (qPhone) qPhone.textContent = chosen.phone;

  const tName  = document.getElementById("ticketFaskesName");
  const tAddr  = document.getElementById("ticketFaskesAddress");
  const tPhone = document.getElementById("ticketFaskesPhone");
  if (tName)  tName.textContent  = chosen.name;
  if (tAddr)  tAddr.textContent  = chosen.address;
  if (tPhone) tPhone.textContent = chosen.phone;

  closeChangeFaskes();
}

/* ---------- Click outside to close overlays ---------- */
window.addEventListener("click", function (e) {
  ["queueModal","faskesModal","doctorModal","changeFaskesModal"].forEach(id => {
    const el = document.getElementById(id);
    if (e.target === el) el.classList.remove("show");
  });
});

/* ---------- FIXED SPEECH-TO-TEXT (PROPER AUDIO CAPTURE) ---------- */
function initSpeechRecognition() {
    const micButton = document.getElementById("micButton");
    const micHint = document.getElementById("micHint");
    const chatArea = document.getElementById("chatArea");
    if (!micButton || !micHint || !chatArea) return;
  
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      micHint.textContent = "Perangkat tidak mendukung pengenalan suara";
      micButton.style.opacity = "0.5";
      return;
    }
  
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
  
    recognition.lang = "id-ID";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
  
    let silenceTimer = null;
    let isProcessing = false;
  
    micButton.addEventListener("click", toggleListening);
  
    function toggleListening() {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    }
  
    function startListening() {
      try {
        // Reset state
        isProcessing = false;
        lastTranscript = "";
        
        // Clear any existing live bubble
        if (liveBubble) {
          liveBubble.remove();
          liveBubble = null;
        }
  
        console.log("🎤 STARTING speech recognition...");
        recognition.start();
        isListening = true;
        micButton.classList.add("active");
        micHint.textContent = "🎤 Mendengarkan... Bicaralah sekarang";
        
        // Set longer silence timeout for initial speech detection
        resetSilenceTimer(8000); // 8 seconds for first speech
        
      } catch (e) {
        console.error("Error starting speech recognition:", e);
        handleRecognitionError(e);
      }
    }
  
    function stopListening() {
      if (!isListening) return;
      
      console.log("🛑 STOPPING listening");
      isListening = false;
      isProcessing = false;
      micButton.classList.remove("active");
      micHint.textContent = hasSpokenOnce ? "Klik untuk berbicara lagi" : "Klik untuk mulai berbicara";
      
      clearTimeout(silenceTimer);
      
      // Clean up live bubble
      if (liveBubble) {
        // If we have interim speech, process it as final
        if (liveBubble.textContent.trim().length > 2 && !isProcessing) {
          const finalText = liveBubble.textContent;
          liveBubble.remove();
          liveBubble = null;
          processFinalTranscript(finalText);
        } else {
          liveBubble.remove();
          liveBubble = null;
        }
      }
      
      // Force stop recognition
      try {
        recognition.stop();
      } catch (e) {
        // Ignore errors when stopping
      }
    }
  
    function resetSilenceTimer(duration = 5000) {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        console.log("⏰ Silence timeout");
        if (isListening) {
          if (liveBubble && liveBubble.textContent.trim().length > 0) {
            console.log("📝 Processing interim speech due to timeout");
            const finalText = liveBubble.textContent;
            liveBubble.remove();
            liveBubble = null;
            processFinalTranscript(finalText);
          } else {
            stopListening();
            micHint.textContent = "Tidak ada suara terdeteksi. Coba lagi.";
          }
        }
      }, duration);
    }
  
    function processFinalTranscript(transcript) {
        if (isProcessing) {
          console.log("🔄 Already processing, skipping:", transcript);
          return;
        }
      
        const cleanTranscript = transcript.trim();
        if (!cleanTranscript || cleanTranscript.length < 2) {
          console.log("📝 Transcript too short, skipping");
          return;
        }
      
        // Check for duplicates
        const now = Date.now();
        if (lastTranscript && 
            cleanTranscript === lastTranscript && 
            (now - lastFinalTime < 2000)) {
          console.log("🔁 Duplicate transcript, skipping");
          return;
        }
      
        console.log("✅ Processing transcript:", cleanTranscript);
        isProcessing = true;
      
        // Clean up live bubble
        if (liveBubble) {
          liveBubble.remove();
          liveBubble = null;
        }
      
        // Add to chat and process
        addChatBubble(cleanTranscript, "user");
        
        // Check for actions and execute them
        const userActions = parseActionsFromUserIntent(cleanTranscript);
        console.log("🎯 Detected actions:", userActions);
        
        if (userActions.length > 0) {
          console.log("🚀 Executing actions directly");
          executeActionSequence(userActions, cleanTranscript);
        } else {
          console.log("🤖 No actions detected, using LLM");
          sendToLLMWithActions(cleanTranscript);
        }
      
        // Update tracking
        lastTranscript = cleanTranscript;
        lastFinalTime = now;
        hasSpokenOnce = true;
      
        // Stop listening after processing
        setTimeout(() => {
          stopListening();
        }, 100);
      }
  
    function handleRecognitionError(error) {
      console.warn("❌ Recognition error:", error);
      
      let errorMessage = "Kesalahan pengenalan suara";
      switch(error) {
        case 'not-allowed':
        case 'permission-denied':
          errorMessage = "Izin mikrofon ditolak. Silakan izinkan akses mikrofon.";
          break;
        case 'no-speech':
          errorMessage = "Tidak ada suara terdeteksi. Pastikan mikrofon berfungsi.";
          break;
        case 'audio-capture':
          errorMessage = "Tidak ada mikrofon yang terdeteksi.";
          break;
        case 'network':
          errorMessage = "Kesalahan jaringan.";
          break;
        default:
          errorMessage = "Kesalahan: " + error;
      }
      
      micHint.textContent = errorMessage;
      stopListening();
    }
  
    recognition.onstart = () => {
      console.log("🎤 Speech recognition STARTED - waiting for speech...");
      resetSilenceTimer(8000); // 8 seconds for first speech detection
    };
  
    recognition.onaudiostart = () => {
      console.log("🔊 Audio input detected");
      resetSilenceTimer(5000); // Reset to normal 5 seconds once audio starts
    };
  
    recognition.onsoundstart = () => {
      console.log("🔊 Sound detected");
      resetSilenceTimer(5000);
    };
  
    recognition.onresult = (event) => {
      console.log("🎯 Speech result received");
      if (!event.results || event.results.length === 0) return;
  
      const results = event.results;
      const latestResult = results[0];
      const transcript = latestResult[0].transcript.trim();
  
      // Reset silence timer on any speech activity
      resetSilenceTimer(5000);
  
      if (!latestResult.isFinal) {
        console.log("📝 Interim result:", transcript);
        // Interim results - show in live bubble
        if (!liveBubble) {
          liveBubble = document.createElement("div");
          liveBubble.className = "chat-bubble user interim";
          liveBubble.style.opacity = "0.7";
          liveBubble.style.fontStyle = "italic";
          chatArea.appendChild(liveBubble);
        }
        liveBubble.textContent = transcript;
      } else {
        console.log("🎯 Final result:", transcript);
        // Final result - process it
        if (liveBubble) {
          liveBubble.remove();
          liveBubble = null;
        }
        processFinalTranscript(transcript);
      }
      
      chatArea.scrollTop = chatArea.scrollHeight;
    };
  
    recognition.onerror = (event) => {
      handleRecognitionError(event.error);
    };
  
    recognition.onend = () => {
      console.log("🔚 Speech recognition ended");
      
      // If we're still listening and have interim speech, process it
      if (isListening && liveBubble && liveBubble.textContent.trim().length > 2 && !isProcessing) {
        console.log("📝 Processing interim speech on end");
        const finalText = liveBubble.textContent;
        liveBubble.remove();
        liveBubble = null;
        processFinalTranscript(finalText);
      } else {
        stopListening();
      }
    };
  }

/* ---------- Toggle: Mode Lansia ---------- */
document.addEventListener("DOMContentLoaded", function() {
  const toggle = document.querySelector(".toggle-switch");
  const container = document.querySelector(".container");
  const bottomNav = document.querySelector(".bottom-nav");
  const micWrapper = document.getElementById("micWrapper");
  const chatContainer = document.getElementById("chatContainer");
  const saveBtn = document.getElementById("saveButton");

  if (saveBtn) saveBtn.addEventListener("click", handleSave);

  micWrapper.classList.add("hidden");
  chatContainer.classList.add("hidden");

  toggle.addEventListener("click", function() {
    this.classList.toggle("active");
    const active = this.classList.contains("active");

    if (active) {
      // Enter Lansia Mode
      container.querySelectorAll(":scope > *:not(.agentic-frame):not(#micWrapper):not(#chatContainer)")
        .forEach(el => el.classList.add("hidden"));
      bottomNav.classList.add("hidden");
      micWrapper.classList.remove("hidden");
      chatContainer.classList.remove("hidden");
      document.body.classList.add("lansia-mode-active");

      setTimeout(initSpeechRecognition, 500);
    } else {
      // Exit Lansia Mode
      container.querySelectorAll(":scope > *:not(.agentic-frame):not(#micWrapper):not(#chatContainer)")
        .forEach(el => el.classList.remove("hidden"));
      bottomNav.classList.remove("hidden");
      micWrapper.classList.add("hidden");
      chatContainer.classList.add("hidden");
      document.body.classList.remove("lansia-mode-active");

      if (isListening && recognition) recognition.stop();
    }
  });

  // Payment screen
  const riwayatTile = document.querySelector('.tile[data-feature="riwayat"]');
  const paymentScreen = document.getElementById("paymentScreen");
  const paymentBack = document.getElementById("paymentBack");
  if (riwayatTile && paymentScreen) {
    riwayatTile.addEventListener("click", function(e) {
      e.preventDefault();
      paymentScreen.classList.remove("hidden");
    });
  }
  if (paymentBack && paymentScreen) {
    paymentBack.addEventListener("click", function(e) {
      e.preventDefault();
      paymentScreen.classList.add("hidden");
    });
  }

  // Participant screen
  const perubahanTile = document.querySelector('.tile[data-feature="perubahan"]');
  const participantScreen = document.getElementById("participantScreen");
  const participantBack = document.getElementById("participantBack");
  if (perubahanTile && participantScreen) {
    perubahanTile.addEventListener("click", function(e) {
      e.preventDefault();
      participantScreen.classList.remove("hidden");
    });
  }
  if (participantBack && participantScreen) {
    participantBack.addEventListener("click", function(e) {
      e.preventDefault();
      participantScreen.classList.add("hidden");
    });
  }

  // Faskes change entry
  const faskesRow = document.getElementById("faskesChangeRow");
  if (faskesRow) faskesRow.addEventListener("click", openChangeFaskes);

  // dropdown change
  const provSel = document.getElementById("provinsiSelect");
  const kotaSel = document.getElementById("kotaSelect");
  if (provSel) provSel.addEventListener("change", populateKotaOptions);
  if (kotaSel) kotaSel.addEventListener("change", populateFaskesOptions);

  const btnChangeFaskes = document.getElementById("btnChangeFaskesSave");
  if (btnChangeFaskes) btnChangeFaskes.addEventListener("click", applyFaskesChange);
});


/* ---------- INIT ---------- */
document.addEventListener("DOMContentLoaded", populateTanggal);

// Expose for voice button
window._sendToLLM = sendToLLMWithActions;
