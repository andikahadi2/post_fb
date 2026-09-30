import "dotenv/config";
import { readFile, rename, writeFile } from "node:fs/promises";
import { trendingTopic } from "./topics.js";

const DRY_RUN = process.argv.includes("--dry");
const HISTORY_FILE = "history.json";
const HISTORY_LIMIT = 300;
const GRAPH_API = "https://graph.facebook.com/v26.0";
const FALLBACK_IMAGE_QUERY = "car automotive";

const {
  UNSPLASH_ACCESS_KEY,
  NINE_ROUTER_API_KEY,
  NINE_ROUTER_BASE_URL = "http://localhost:20128/v1",
  NINE_ROUTER_MODEL = "gh/gpt-5.4",
  FB_PAGE_ID,
  FB_PAGE_ACCESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RETRY_DELAY_MS = "2000",
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

// Kabari lewat Telegram kalau posting gagal; opsional, dilewati kalau belum dikonfigurasi.
async function notifyFailure(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await request("Telegram", `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      body: new URLSearchParams({ chat_id: TELEGRAM_CHAT_ID, text: `⚠️ Auto-post FB gagal:\n${message}` }),
    });
  } catch (err) {
    console.warn(`Notifikasi Telegram gagal: ${err.message}`);
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
async function saveHistory(history, entry) {
  const next = [...history, entry].slice(-HISTORY_LIMIT);
  // Tulis ke file sementara lalu rename, supaya crash di tengah tidak merusak history.
  await writeFile(`${HISTORY_FILE}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${HISTORY_FILE}.tmp`, HISTORY_FILE);
}

async function findImage(imageKeywords, usedPhotoIds) {
  const firstPhrase = imageKeywords.split(",")[0].trim();
  const queries = [...new Set([imageKeywords, firstPhrase, FALLBACK_IMAGE_QUERY])];

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
  `Tulisan kamu selalu mengikuti struktur:\n` +
  `1. HOOK - kalimat pembuka yang bikin orang berhenti scroll (pertanyaan, fakta mengejutkan, atau pernyataan berani).\n` +
  `2. ISI - 1-2 insight/tips konkret yang bernilai, ditulis singkat dan mudah dicerna, gaya ngobrol tapi tetap kredibel.\n` +
  `3. CTA - ajakan ringan di akhir yang mendorong interaksi (komentar, share, atau tag teman), bukan CTA jualan yang maksa.\n` +
  `Hindari clickbait kosong, klaim berlebihan, dan bahasa yang kaku/formal. Gunakan emoji secukupnya (maks 2-3) kalau pas.`;

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
    caption: `${topic}\n\nMenurut kamu gimana? Tulis pendapatmu di komentar 👇\n\n#otomotif #mobil #beritaotomotif`,
    imageKeywords: FALLBACK_IMAGE_QUERY,
  };
}

async function generateCaptionAndKeywords(topic) {
  const prompt = `Buatkan caption Facebook berdasarkan topik/judul berita otomotif ini: "${topic}". Maksimal 120 kata, ` +
    `tambahkan 3-5 hashtag relevan di akhir. Jangan mengarang angka, harga, atau fakta spesifik yang tidak ada di judul; ` +
    `kalau perlu, fokus ke opini, konteks umum, atau tips yang berkaitan.\n\n` +
    `Lalu buat juga 2-4 keyword pencarian gambar dalam Bahasa Inggris yang paling relevan dengan isi caption itu, ` +
    `dipisah koma, yang paling penting di depan ` +
    `(untuk dicari di Unsplash, jadi keyword harus konkret/visual, misal "electric SUV, charging station" bukan "teknologi masa depan").\n\n` +
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
    body: new URLSearchParams({ url: imageUrl, caption, access_token: FB_PAGE_ACCESS_TOKEN }),
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

  const history = await loadHistory();
  const usedTopics = new Set(history.map((h) => h.topic));
  const usedPhotoIds = new Set(history.map((h) => h.photoId));

  const { topic, source } = await trendingTopic(usedTopics);
  console.log(`[1/4] Topik (${source}): ${topic}`);

  let generated;
  try {
    generated = await generateCaptionAndKeywords(topic);
  } catch (err) {
    console.warn(`Caption AI gagal (${err.message}), pakai caption cadangan.`);
    generated = fallbackCaption(topic);
  }
  const { caption, imageKeywords } = generated;
  console.log(`[2/4] Image keywords: ${imageKeywords}`);

  const image = await findImage(imageKeywords, usedPhotoIds);
  console.log(`[3/4] Gambar: ${image.imageUrl} (by ${image.photographer})`);

  const fullCaption = `${caption}\n\n📷 Foto: ${image.photographer} / Unsplash`;
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
    photoId: image.id,
    postId,
  });
  await trackUnsplashDownload(image.downloadLocation);
}

if (import.meta.main ?? process.argv[1]?.endsWith("post.js")) {
  main().catch(async (err) => {
    console.error("Gagal posting:", err.message);
    await notifyFailure(err.message);
    // process.exit() di Windows bisa crash (UV_HANDLE_CLOSING) saat socket fetch masih ditutup.
    process.exitCode = 1;
  });
}
