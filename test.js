import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHeadlines, parseItems } from "./topics.js";
import { nextRun, parseLog } from "./dashboard.js";
import { catchupDue, fallbackCaption, parseAiReply } from "./post.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// --- Unit: parser ---

check("parseHeadlines: decode entity & buang nama media", () => {
  const xml = `<channel><title>feed</title>` +
    `<item><title>Mobil Listrik &amp; Hybrid Laris - Kompas.com</title></item>` +
    `<item><title>Tips &quot;Aman&quot; Mudik - Tol-Jalan - Detik</title></item>` +
    `</channel>`;
  assert.deepStrictEqual(parseHeadlines(xml), ["Mobil Listrik & Hybrid Laris", 'Tips "Aman" Mudik - Tol-Jalan']);
});

check("parseHeadlines: nama media yang mengandung ' - ' dipotong utuh via <source>", () => {
  const xml = `<item><title>Daihatsu Perkuat Ekspor - Bisnis.com - Otomotif</title><link>x</link>` +
    `<source url="https://otomotif.bisnis.com">Bisnis.com - Otomotif</source></item>`;
  assert.deepStrictEqual(parseHeadlines(xml), ["Daihatsu Perkuat Ekspor"]);
});

check("parseHeadlines: domain media di dalam judul ikut dibuang", () => {
  const xml = `<item><title>Velg Mobil 2026: Tips Memilih - paltv.disway.id - Disway</title><source url="x">Disway</source></item>`;
  assert.deepStrictEqual(parseHeadlines(xml), ["Velg Mobil 2026: Tips Memilih"]);
});

check("parseItems: nama media & domain sumber ikut diambil (domain kosong kalau url tidak valid)", () => {
  const xml = `<item><title>Judul - Kompas</title><source url="https://otomotif.kompas.com">Kompas</source></item>` +
    `<item><title>Lain - X</title><source url="bukan-url">X</source></item>`;
  assert.deepStrictEqual(parseItems(xml), [
    { title: "Judul", sourceName: "Kompas", sourceHost: "otomotif.kompas.com" },
    { title: "Lain", sourceName: "X", sourceHost: "" },
  ]);
});

check("catchupDue: hanya kalau slot hari ini lewat & belum ada posting sesudahnya", () => {
  const at = (h, m = 0) => new Date(2026, 0, 5, h, m);
  const post = (h) => [{ date: at(h).toISOString() }];
  assert.strictEqual(catchupDue([], at(18, 59), 19), false); // belum waktunya
  assert.strictEqual(catchupDue([], at(20), 19), true); // terlewat, belum pernah posting
  assert.strictEqual(catchupDue(post(19), at(20), 19), false); // sudah posting di slot ini
  assert.strictEqual(catchupDue(post(8), at(20), 19), true); // posting lama sebelum slot
  assert.strictEqual(catchupDue([{ date: new Date(2026, 0, 4, 19, 5).toISOString() }], at(20), 19), true); // kemarin
});

check("parseAiReply: JSON dalam code block + keyword array", () => {
  const raw = "```json\n{\"caption\": \" Halo \", \"imageKeywords\": [\"electric SUV\", \"charging station\"]}\n```";
  assert.deepStrictEqual(parseAiReply(raw), { caption: "Halo", imageKeywords: "electric SUV, charging station" });
});

check("parseAiReply: ada teks sebelum JSON", () => {
  assert.strictEqual(parseAiReply('Berikut hasilnya: {"caption":"A","imageKeywords":"car"}').caption, "A");
});

check("parseAiReply: menolak balasan tanpa JSON / field kosong", () => {
  assert.throws(() => parseAiReply("maaf saya tidak bisa"), /tidak berisi JSON/);
  assert.throws(() => parseAiReply('{"caption":"A"}'), /imageKeywords/);
  assert.throws(() => parseAiReply('{"caption":"","imageKeywords":"car"}'), /caption/);
});

check("parseLog: hasil run terakhir menang, tail dibatasi", () => {
  const log = "=== a ===\nPosted! post_id: 1\n=== b ===\nGagal posting: Token expired\n";
  assert.deepStrictEqual(parseLog(log).lastRun, { ok: false, message: "Token expired" });
  assert.strictEqual(parseLog("Posted! x\n").lastRun.ok, true);
  assert.strictEqual(parseLog("").lastRun, null);
  assert.strictEqual(parseLog("x\n".repeat(200)).tail.length, 60);
});

check("nextRun: jadwal 19:00 hari ini, lompat ke besok setelah lewat", () => {
  assert.strictEqual(new Date(nextRun(new Date(2026, 0, 5, 7, 0))).getHours(), 19);
  const d = new Date(nextRun(new Date(2026, 0, 5, 20, 0)));
  assert.deepStrictEqual([d.getDate(), d.getHours()], [6, 19]);
});

// --- End-to-end: jalankan post.js sungguhan dengan fetch palsu ---

const ROOT = import.meta.dirname;
const MOCK = pathToFileURL(join(ROOT, "test-mock.js")).href;
const dir = mkdtempSync(join(tmpdir(), "aipostfb-"));
const LOG = join(dir, "calls.log");
const HISTORY = join(dir, "history.json");

function run(scenario, { args = [], env = {} } = {}) {
  rmSync(LOG, { force: true });
  const r = spawnSync(process.execPath, ["--import", MOCK, join(ROOT, "post.js"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      UNSPLASH_ACCESS_KEY: "u",
      NINE_ROUTER_API_KEY: "n",
      FB_PAGE_ID: "123",
      FB_PAGE_ACCESS_TOKEN: "t",
      ...env,
      RETRY_DELAY_MS: "0",
      MOCK_SCENARIO: JSON.stringify(scenario),
      MOCK_LOG: LOG,
    },
  });
  const calls = existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { code: r.status, out: r.stdout + r.stderr, calls, routes: calls.map((c) => c.route) };
}

const history = () => (existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : []);
const photo = (id, name) => ({
  id,
  urls: { regular: `https://img.test/${id}.jpg` },
  user: { name },
  links: { download_location: `https://api.unsplash.com/photos/${id}/download` },
});
const aiReply = (content) => ({ body: { choices: [{ message: { content } }] } });

const RSS = { body: "<rss><channel><item><title>Berita A - Kompas</title><source url=\"https://a.test\">Kompas</source></item><item><title>Berita B - Detik</title><source url=\"https://b.test\">Detik</source></item></channel></rss>" };
const AI_OK = aiReply('```json\n{"caption":"Halo otomotif","imageKeywords":["electric SUV","charging station"]}\n```');
const base = {
  rss: RSS,
  ai: AI_OK,
  "unsplash:electric SUV": { body: [photo("p1", "Ann")] },
  "unsplash:charging station": { status: 404, body: '{"errors":["No photos found."]}' },
  "unsplash:car automotive": { body: [photo("g1", "Generik")] },
  download: { body: "{}" },
  debug: { body: { data: { is_valid: true, expires_at: 0 } } },
  fb: { body: { id: "photo1", post_id: "123_1" } },
};

try {
  check("e2e: posting sukses, keyword dicoba satu per satu, sumber berita & kredit foto, history tersimpan", () => {
    const r = run(base);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.routes, [
      "debug", "rss", "ai", "unsplash:electric SUV", "fb", "download",
    ]);
    const fb = r.calls.find((c) => c.route === "fb");
    assert.match(fb.url, /graph\.facebook\.com\/v26\.0\/123\/photos$/);
    const params = new URLSearchParams(fb.body);
    assert.strictEqual(params.get("url"), "https://img.test/p1.jpg");
    assert.match(params.get("caption"), /^Halo otomotif\n\n📰 Sumber: (Kompas · a\.test|Detik · b\.test)\n📷 Foto: Ann \/ Unsplash$/);
    assert.strictEqual(params.get("access_token"), "t");
    const h = history();
    assert.strictEqual(h.length, 1);
    assert.strictEqual(h[0].photoId, "p1");
    assert.strictEqual(h[0].postId, "123_1");
    assert.ok(["Berita A", "Berita B"].includes(h[0].topic));
  });

  check("e2e: run kedua tidak mengulang topik & foto yang sama", () => {
    const r = run({ ...base, "unsplash:electric SUV": { body: [photo("p1", "Ann"), photo("p2", "Budi")] } });
    assert.strictEqual(r.code, 0, r.out);
    const h = history();
    assert.strictEqual(h.length, 2);
    assert.notStrictEqual(h[1].topic, h[0].topic);
    assert.strictEqual(h[1].photoId, "p2");
    assert.match(new URLSearchParams(r.calls.find((c) => c.route === "fb").body).get("caption"), /Foto: Budi/);
  });

  check("e2e: dry run tanpa key FB, tidak posting & tidak menyentuh history; foto terpakai -> keyword umum", () => {
    const r = run(base, { args: ["--dry"], env: { FB_PAGE_ID: "", FB_PAGE_ACCESS_TOKEN: "" } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Foto: Generik \/ Unsplash/);
    assert.ok(!r.routes.includes("fb") && !r.routes.includes("download"));
    assert.strictEqual(history().length, 2);
  });

  check("e2e: tanpa key FB (bukan dry run) langsung gagal dengan pesan jelas", () => {
    const r = run(base, { env: { FB_PAGE_ACCESS_TOKEN: "" } });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Missing env vars: FB_PAGE_ACCESS_TOKEN/);
    assert.strictEqual(r.calls.length, 0);
  });

  check("e2e: RSS mati -> topik statis; balasan AI rusak -> dicoba ulang", () => {
    const r = run(
      { ...base, rss: { status: 500, body: "down" }, ai: [aiReply("maaf saya tidak bisa"), AI_OK] },
      { args: ["--dry"] },
    );
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Topik \(statis\)/);
    assert.match(r.out, /coba lagi/);
    assert.strictEqual(r.routes.filter((x) => x === "ai").length, 2);
  });

  check("e2e: AI tetap rusak setelah 2x -> pakai caption cadangan", () => {
    const r = run({ ...base, ai: aiReply("tidak ada json") }, { args: ["--dry"] });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /tidak valid setelah 2x coba.*caption cadangan/s);
    assert.match(r.out, /Menurut kamu gimana/);
  });

  check("e2e: 9Router mati -> dicoba ulang, lalu caption cadangan dengan pesan 9Router", () => {
    const r = run({ ...base, ai: { throw: "ECONNREFUSED" } }, { args: ["--dry"] });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /pastikan 9Router sudah jalan.*ECONNREFUSED/);
    assert.strictEqual(r.routes.filter((x) => x === "ai").length, 2);
  });

  check("e2e: Unsplash 5xx sementara -> dicoba ulang", () => {
    const r = run({ ...base, "unsplash:electric SUV": [{ status: 503, body: "x" }, { body: [photo("p9", "Dedi")] }] }, { args: ["--dry"] });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Foto: Dedi/);
  });

  check("e2e: gagal posting -> kirim notifikasi Telegram", () => {
    const r = run(
      { ...base, "unsplash:electric SUV": { body: [photo("p8", "Eka")] }, fb: { status: 400, body: { error: { message: "Token expired" } } }, "telegram": { body: { ok: true } } },
      { env: { TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "c" } },
    );
    assert.strictEqual(r.code, 1);
    const tg = r.calls.find((c) => c.route === "telegram");
    assert.match(new URLSearchParams(tg.body).get("text"), /Token expired/);
  });

  check("e2e: --catchup tanpa jadwal terlewat -> tidak menghubungi siapa pun", () => {
    const r = run(base, { args: ["--catchup"], env: { POST_HOUR: "0" } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /tidak ada jadwal yang terlewat/);
    assert.strictEqual(r.calls.length, 0);
  });

  check("e2e: token FB hampir kedaluwarsa -> peringatan Telegram, posting tetap jalan", () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const r = run(
      { ...base, "unsplash:electric SUV": { body: [photo("p7", "Fani")] }, debug: { body: { data: { is_valid: true, expires_at: soon } } }, telegram: { body: { ok: true } } },
      { env: { TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "c" } },
    );
    assert.strictEqual(r.code, 0, r.out);
    assert.match(new URLSearchParams(r.calls.find((c) => c.route === "telegram").body).get("text"), /Token Facebook kedaluwarsa/);
    assert.ok(r.routes.includes("fb"));
  });

  check("fallbackCaption: berisi topik & hashtag", () => {
    assert.match(fallbackCaption("Topik X").caption, /^Topik X\n[\s\S]*#otomotif/);
  });

  check("e2e: semua pencarian Unsplash kosong -> gagal, 3 query dicoba", () => {
    const { "unsplash:electric SUV": _a, "unsplash:car automotive": _b, ...noPhotos } = base;
    const r = run({ ...noPhotos, "unsplash:*": { status: 404, body: "{}" } }, { args: ["--dry"] });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Tidak menemukan gambar baru/);
    assert.strictEqual(r.routes.filter((x) => x.startsWith("unsplash:")).length, 3);
  });

  check("e2e: Facebook menolak token -> gagal, history & download tidak tercatat", () => {
    const r = run({ ...base, "unsplash:electric SUV": { body: [photo("p3", "Cici")] }, fb: { status: 400, body: { error: { message: "Invalid OAuth access token." } } } });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Invalid OAuth access token/);
    assert.ok(!r.routes.includes("download"));
    assert.strictEqual(history().length, 3);
  });

  check("e2e: Facebook membalas HTML (bukan JSON) -> pesan error tetap terbaca", () => {
    const r = run({ ...base, "unsplash:electric SUV": { body: [photo("p3", "Cici")] }, fb: { status: 502, body: "<html>Bad Gateway</html>" } });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Facebook error 502: <html>Bad Gateway/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} test OK`);
