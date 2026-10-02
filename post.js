import "dotenv/config";
import { readFile, rename, writeFile } from "node:fs/promises";
import { trendingTopic } from "./topics.js";

const DRY_RUN = process.argv.includes("--dry");
const CATCHUP = process.argv.includes("--catchup");
const HISTORY_FILE = "history.json";
const HISTORY_LIMIT = 300;
const GRAPH_API = "https://graph.facebook.com/v26.0";
const FALLBACK_IMAGE_QUERY = "car automotive";

const {
  UNSPLASH_ACCESS_KEY,
  NINE_ROUTER_API_KEY,
  NINE_ROUTER_BASE_URL = "http://localhost:20128/v1",
  NINE_ROUTER_MODEL = "gh/claude-haiku-4.5",
  FB_PAGE_ID,
  FB_PAGE_ACCESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRY_DELAY_MS = "2000",
  POST_HOUR = "19",
} = process.env;

function requireEnv() {
  const required = { UNSPLASH_ACCESS_KEY, NINE_ROUTER_API_KEY };
  if (!DRY_RUN) Object.assign(required, { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN });
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing env vars: ${missing.join(", ")}. Copy .env.example to .env and fill it in.`);
  }
}

// Semua request diberi batas waktu supaya jadwal otomatis tidak menggantung selamanya.
// retries hanya untuk request yang aman diulang (jangan dipakai untuk POST ke Facebook: bisa dobel posting).
async function request(name, url, { timeoutMs = 30_000, retries = 0, ...options } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, failure;
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 && res.status < 500) return res;
    } catch (err) {
      const reason = err.name === "TimeoutError" ? `timeout ${timeoutMs / 1000} detik` : err.cause?.code || err.message;
      failure = new Error(`${name} tidak bisa dihubungi (${reason})`);
    }
    if (attempt >= retries) {
      if (failure) throw failure;
      return res;
    }
    console.warn(`${name} gagal (${failure ? failure.message : `HTTP ${res.status}`}), coba lagi...`);
    await new Promise((r) => setTimeout(r, Number(RETRY_DELAY_MS) * (attempt + 1)));
  }
}

// Kabari lewat Telegram (gagal posting / token hampir habis); opsional, dilewati kalau belum dikonfigurasi.
async function notify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await request("Telegram", `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      body: new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    console.warn(`Notifikasi Telegram gagal: ${err.message}`);
  }
}

let pageToken = FB_PAGE_ACCESS_TOKEN;

// Slot hari ini (jam POST_HOUR) terlewat dan belum ada posting sesudahnya -> perlu dikejar.
export function catchupDue(history, now = new Date(), hour = Number(POST_HOUR)) {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  const last = history.at(-1)?.date;
  return now >= slot && (!last || new Date(last) < slot);
}

// Token Page dari token pengguna jangka pendek bisa kedaluwarsa dalam hitungan jam; kabari sebelum job gagal.
async function checkFacebookToken() {
  try {
    const url = new URL(`${GRAPH_API}/debug_token`);
    url.searchParams.set("input_token", pageToken);
    url.searchParams.set("access_token", pageToken);
    let data = (await (await request("Facebook token", url, { retries: 1 })).json()).data;
    // Token pengguna tidak boleh dipakai posting ke Page (error #200 publish_actions): tukar ke token Page.
    if (data?.type === "USER") {
      const swap = new URL(`${GRAPH_API}/${FB_PAGE_ID}`);
      swap.searchParams.set("fields", "access_token");
      swap.searchParams.set("access_token", pageToken);
      const page = await (await request("Facebook token Page", swap, { retries: 1 })).json();
      if (!page.access_token) throw new Error(page.error?.message || "akun ini tidak punya akses ke Page");
      console.warn("FB_PAGE_ACCESS_TOKEN berisi token pengguna; otomatis ditukar ke token Page. Perbaiki .env dengan npm run fb-token.");
      pageToken = page.access_token;
      url.searchParams.set("input_token", pageToken);
      url.searchParams.set("access_token", pageToken);
      data = (await (await request("Facebook token", url, { retries: 1 })).json()).data;
    }
    if (data?.expires_at && data.expires_at * 1000 - Date.now() < 3 * 86_400_000) {
      const when = new Date(data.expires_at * 1000).toLocaleString("id-ID");
      console.warn(`Token Facebook kedaluwarsa ${when}.`);
      await notify(`⚠️ Token Facebook kedaluwarsa ${when}. Buat token permanen: npm run fb-token -- <user_token>`);
    }
  } catch (err) {
    console.warn(`Cek token Facebook dilewati: ${err.message}`);
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// ponytail: simpan 300 entri terakhir saja, cukup untuk ~5 bulan posting 2x sehari
async function writeHistory(list) {
  // Tulis ke file sementara lalu rename, supaya crash di tengah tidak merusak history.
  await writeFile(`${HISTORY_FILE}.tmp`, JSON.stringify(list.slice(-HISTORY_LIMIT), null, 2));
  await rename(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
}

const saveHistory = (history, entry) => writeHistory([...history, entry]);

const METRICS_MIN_AGE_MS = 24 * 3_600_000;
const METRICS_PER_RUN = 10;
// Komentar dan share lebih berharga bagi algoritma Facebook daripada reaksi.
export const engagementScore = ({ reactions, comments, shares }) => reactions + 3 * comments + 5 * shares;

// Ambil reaksi/komentar/share posting yang sudah >24 jam, sekali saja per posting. Gagal tidak boleh menghalangi posting.
async function refreshMetrics(history) {
  const due = history
    .filter((h) => h.postId && !h.metrics && Date.now() - new Date(h.date) >= METRICS_MIN_AGE_MS)
    .slice(0, METRICS_PER_RUN);
  if (!due.length) return history;

  for (const entry of due) {
    try {
      const url = new URL(`${GRAPH_API}/${entry.postId}`);
      url.searchParams.set("fields", "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares");
      url.searchParams.set("access_token", pageToken);
      const res = await request("Facebook metrik", url, { retries: 1 });
      const data = await res.json();
      if (!res.ok || data.error) {
        entry.metrics = { error: data.error?.message || `HTTP ${res.status}` }; // jangan dicoba terus (mis. posting dihapus)
        continue;
      }
      const m = {
        reactions: data.reactions?.summary?.total_count ?? 0,
        comments: data.comments?.summary?.total_count ?? 0,
        shares: data.shares?.count ?? 0,
      };
      entry.metrics = { ...m, score: engagementScore(m), at: new Date().toISOString() };
    } catch (err) {
      console.warn(`Ambil metrik ${entry.postId} dilewati: ${err.message}`);
    }
  }
  await writeHistory(history);
  return history;
}

const formatName = (f) => f.split(":")[0];

// Format yang belum cukup data (<2 posting berhasil diukur) dicoba dulu; sesudah itu 75% pilih rata-rata skor terbaik, 25% acak.
export function pickFormat(history, rand = Math.random) {
  const stats = new Map(CAPTION_FORMATS.map((f) => [f, { n: 0, sum: 0 }]));
  for (const h of history) {
    const f = CAPTION_FORMATS.find((x) => formatName(x) === h.format);
    if (f && typeof h.metrics?.score === "number") {
      stats.get(f).n++;
      stats.get(f).sum += h.metrics.score;
    }
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const untested = CAPTION_FORMATS.filter((f) => stats.get(f).n < 2);
  if (untested.length) return pick(untested);
  if (rand() < 0.25) return pick(CAPTION_FORMATS);
  return CAPTION_FORMATS.reduce((best, f) => (stats.get(f).sum / stats.get(f).n > stats.get(best).sum / stats.get(best).n ? f : best));
}

async function findImage(imageKeywords, usedPhotoIds) {
  // Unsplash mencocokkan seluruh query sekaligus, jadi daftar keyword digabung hampir selalu kosong: coba satu per satu.
  const phrases = imageKeywords.split(",").map((k) => k.trim()).filter(Boolean).slice(0, 3);
  const queries = [...new Set([...phrases, FALLBACK_IMAGE_QUERY])];

  for (const query of queries) {
    const url = new URL("https://api.unsplash.com/photos/random");
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("content_filter", "high");
    url.searchParams.set("count", "10");

    const res = await request("Unsplash", url, {
      headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
      retries: 2,
    });
    // Unsplash membalas 404 kalau keyword tidak menemukan foto apa pun.
    if (res.status === 404) {
      console.warn(`Tidak ada gambar untuk "${query}", coba keyword lain.`);
      continue;
    }
    if (!res.ok) throw new Error(`Unsplash error ${res.status}: ${await res.text()}`);

    const photo = (await res.json()).find((p) => !usedPhotoIds.has(p.id));
    if (!photo) {
      console.warn(`Semua gambar untuk "${query}" sudah pernah dipakai, coba keyword lain.`);
      continue;
    }
    return {
      id: photo.id,
      imageUrl: photo.urls.regular,
      photographer: photo.user?.name || "Unsplash",
      downloadLocation: photo.links.download_location,
    };
  }
  throw new Error("Tidak menemukan gambar baru di Unsplash.");
}

// Wajib menurut Unsplash API guidelines setiap kali foto benar-benar dipakai.
async function trackUnsplashDownload(downloadLocation) {
  const res = await request("Unsplash download", downloadLocation, {
    headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` },
  });
  if (!res.ok) console.warn(`Unsplash download tracking gagal: ${res.status}`);
}

const COPYWRITER_SYSTEM_PROMPT = `Kamu adalah copywriter media sosial profesional untuk halaman Facebook otomotif berbahasa Indonesia. ` +
  `Tujuanmu: caption yang bikin orang berhenti scroll dan ingin membalas, bukan sekadar membaca.\n` +
  `Aturan:\n` +
  `- Baris pertama adalah HOOK yang kuat (maks 12 kata, tanpa basa-basi): angka/fakta tajam dari judul, kontras, atau pertanyaan yang memancing opini.\n` +
  `- Kalimat pendek, satu ide per baris, gaya ngobrol orang Indonesia (boleh "kamu", "gak", "nih"), tetap kredibel.\n` +
  `- Akhiri dengan SATU pertanyaan spesifik yang mudah dijawab dalam 1 kata atau 1 kalimat, dan punya dua kubu yang jelas ` +
  `(misal "Tim A atau Tim B?"). Pertanyaannya harus muncul alami dari topik.\n` +
  `- DILARANG meminta like, komentar, share, atau tag teman secara eksplisit, dan jangan pakai "klik/tulis di komentar". ` +
  `Facebook menurunkan jangkauan posting yang seperti itu.\n` +
  `- Hindari clickbait kosong, klaim berlebihan, dan bahasa kaku/formal. Emoji maks 2.`;

// Diputar acak tiap posting supaya feed tidak monoton; tiap format memicu jenis interaksi berbeda.
export const CAPTION_FORMATS = [
  "OPINI TAJAM: ambil satu sikap yang berani tapi masuk akal soal topik ini, lalu tantang pembaca setuju atau tidak.",
  "PILIH SALAH SATU: bingkai topik sebagai dua pilihan yang saling bersaing (A vs B), singkat, lalu tanya mereka pilih yang mana.",
  "TAHUKAH KAMU: satu fakta/konteks umum yang membuat orang bilang 'oh iya ya', tanpa mengarang angka di luar judul.",
  "TIPS CEPAT: 3 poin pendek yang langsung berguna buat pemilik mobil dan berhubungan dengan topik, lalu tanya pengalaman mereka.",
  "CERITA MINI: 2-3 kalimat situasi relatable pemilik kendaraan yang terhubung ke topik, lalu tanya 'pernah ngalamin?'.",
];

// Model kadang membungkus JSON dengan teks/markdown, atau mengirim keyword sebagai array.
export function parseAiReply(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("balasan AI tidak berisi JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1));

  const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
  const keywords = Array.isArray(parsed.imageKeywords) ? parsed.imageKeywords.join(", ") : parsed.imageKeywords;
  const imageKeywords = typeof keywords === "string" ? keywords.trim() : "";
  if (!caption || !imageKeywords) throw new Error("JSON dari AI tidak punya caption/imageKeywords");
  return { caption, imageKeywords };
}

// Dipakai kalau AI mati/rusak supaya jadwal posting tidak bolong.
export function fallbackCaption(topic) {
  return {
    caption: `${topic}\n\nMenurut kamu, ini kabar baik atau justru bikin ragu?\n\n#otomotif #mobil #beritaotomotif`,
    imageKeywords: FALLBACK_IMAGE_QUERY,
  };
}

async function generateCaptionAndKeywords(topic, format) {
  const prompt = `Buatkan caption Facebook berdasarkan topik/judul berita otomotif ini: "${topic}".\n` +
    `Format yang dipakai kali ini -> ${format}\n` +
    `Maksimal 100 kata, ` +
    `tambahkan 3-5 hashtag relevan di akhir. Jangan mengarang angka, harga, atau fakta spesifik yang tidak ada di judul; ` +
    `kalau perlu, fokus ke opini, konteks umum, atau tips yang berkaitan.\n\n` +
    `Lalu buat juga 2-4 keyword pencarian gambar dalam Bahasa Inggris yang paling relevan dengan isi caption itu, ` +
    `dipisah koma, yang paling penting di depan. Setiap keyword pendek (1-3 kata), sederhana, dan konkret/visual, ` +
    `mulai dari merek atau jenis kendaraan yang umum ada di foto stok, misal "Nissan car, electric SUV, car showroom" ` +
    `bukan "teknologi masa depan" atau frasa panjang yang terlalu spesifik.\n\n` +
    `Balas HANYA dalam format JSON persis seperti ini, tanpa markdown code block, tanpa teks lain:\n` +
    `{"caption": "...", "imageKeywords": "..."}`;

  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; ; attempt++) {
    const res = await request(`9Router (${NINE_ROUTER_BASE_URL}) - pastikan 9Router sudah jalan`, `${NINE_ROUTER_BASE_URL}/chat/completions`, {
      timeoutMs: 120_000,
      retries: 1,
      method: "POST",
      headers: {
        Authorization: `Bearer ${NINE_ROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: NINE_ROUTER_MODEL,
        messages: [
          { role: "system", content: COPYWRITER_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`9Router error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    try {
      return parseAiReply(data.choices?.[0]?.message?.content || "");
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new Error(`Balasan AI tidak valid setelah ${MAX_ATTEMPTS}x coba: ${err.message}`);
      console.warn(`Balasan AI tidak valid (${err.message}), coba lagi...`);
    }
  }
}

async function postToFacebook(imageUrl, caption) {
  const res = await request("Facebook", `${GRAPH_API}/${FB_PAGE_ID}/photos`, {
    method: "POST",
    body: new URLSearchParams({ url: imageUrl, caption, access_token: pageToken }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Facebook error ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || data.error) throw new Error(`Facebook error: ${data.error?.message || text}`);
  return data;
}

async function main() {
  console.log(`\n=== ${new Date().toLocaleString("id-ID")} ===`);
  requireEnv();

  if (DRY_RUN) console.log("=== DRY RUN: tidak akan posting ke Facebook ===");

  let history = await loadHistory();
  if (CATCHUP && !catchupDue(history)) {
    console.log("Catch-up: tidak ada jadwal yang terlewat, lewati.");
    return;
  }
  if (!DRY_RUN) {
    await checkFacebookToken();
    history = await refreshMetrics(history);
  }
  const usedTopics = new Set(history.map((h) => h.topic));
  const usedPhotoIds = new Set(history.map((h) => h.photoId));

  const { topic, source, credit } = await trendingTopic(usedTopics);
  console.log(`[1/4] Topik (${source}): ${topic}`);

  const format = pickFormat(history);
  console.log(`Format caption: ${formatName(format)}`);
  let generated;
  try {
    generated = await generateCaptionAndKeywords(topic, format);
  } catch (err) {
    console.warn(`Caption AI gagal (${err.message}), pakai caption cadangan.`);
    generated = fallbackCaption(topic);
  }
  const { caption, imageKeywords } = generated;
  console.log(`[2/4] Image keywords: ${imageKeywords}`);

  const image = await findImage(imageKeywords, usedPhotoIds);
  console.log(`[3/4] Gambar: ${image.imageUrl} (by ${image.photographer})`);

  const sourceLine = credit ? `📰 Sumber: ${credit}\n` : "";
  const fullCaption = `${caption}\n\n${sourceLine}📷 Foto: ${image.photographer} / Unsplash`;
  console.log(`\n${fullCaption}\n`);

  if (DRY_RUN) {
    console.log("[4/4] Dry run selesai, tidak diposting.");
    return;
  }

  const result = await postToFacebook(image.imageUrl, fullCaption);
  const postId = result.post_id || result.id;
  console.log(`[4/4] Posted! post_id: ${postId}`);

  await saveHistory(history, {
    date: new Date().toISOString(),
    topic,
    format: formatName(format),
    photoId: image.id,
    postId,
  });
  await trackUnsplashDownload(image.downloadLocation);
}

if (import.meta.main ?? process.argv[1]?.endsWith("post.js")) {
  main().catch(async (err) => {
    console.error("Gagal posting:", err.message);
    await notify(`⚠️ Auto-post FB gagal:\n${err.message}`);
    // process.exit() di Windows bisa crash (UV_HANDLE_CLOSING) saat socket fetch masih ditutup.
    process.exitCode = 1;
  });
}
