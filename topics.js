// ponytail: daftar statis, cukup untuk niche otomotif. Tambah entri kalau mau variasi lebih banyak.
export const TOPICS = [
  "mobil listrik terbaru",
  "inovasi teknologi otomotif",
  "tips merawat mesin mobil",
  "tips merawat AC mobil",
  "modifikasi mobil JDM",
  "perawatan ban mobil",
  "mobil sport terbaru",
  "teknologi self-driving",
  "tips berkendara aman",
  "supercar terbaru",
  "motor listrik",
  "restorasi mobil klasik",
  "aksesoris interior mobil",
  "tips servis berkala mobil",
  "tren otomotif hits",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function randomTopic() {
  return pick(TOPICS);
}

const NEWS_RSS = "https://news.google.com/rss/search?q=otomotif+mobil+when:3d&hl=id&gl=ID&ceid=ID:id";

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Judul Google News berbentuk "Judul - Nama Media"; nama media bisa mengandung " - " juga,
// jadi dipotong pakai isi <source> kalau ada.
export function parseItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const source = decode(item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "");
      // Link <link> Google News terenkripsi & panjang (tidak bisa jadi URL artikel asli), jadi pakai media + domainnya.
      const sourceUrl = decode(item.match(/<source[^>]*url="([^"]*)"/)?.[1] ?? "");
      let host = "";
      try { host = new URL(sourceUrl).host; } catch {}
      const suffix = ` - ${source}`;
      const stripped = source && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title.replace(/\s+-\s+[^-]+$/, "");
      // Sebagian media menaruh domainnya sendiri di judul: "Judul - paltv.disway.id - Disway".
      return { title: stripped.replace(/\s+-\s+\S+\.[a-z]{2,}$/i, "").trim(), sourceName: source, sourceHost: host };
    })
    .filter((i) => i.title);
}

export const parseHeadlines = (xml) => parseItems(xml).map((i) => i.title);

// ponytail: ambil acak dari 10 berita teratas yang belum pernah dipakai; fallback ke daftar statis kalau RSS gagal/habis
export async function trendingTopic(usedTopics = new Set()) {
  try {
    const res = await fetch(NEWS_RSS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseItems(await res.text())
      .filter((i) => !usedTopics.has(i.title))
      .slice(0, 10);
    if (!items.length) throw new Error("tidak ada berita baru");
    const { title, sourceName, sourceHost } = pick(items);
    return { topic: title, source: "berita", credit: [sourceName, sourceHost].filter(Boolean).join(" · ") };
  } catch (err) {
    console.warn(`RSS berita gagal (${err.message}), pakai topik statis.`);
    const fresh = TOPICS.filter((t) => !usedTopics.has(t));
    return { topic: pick(fresh.length ? fresh : TOPICS), source: "statis" };
  }
}
