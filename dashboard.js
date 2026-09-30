// Dashboard pemantauan (read-only): node dashboard.js  ->  http://127.0.0.1:3000
import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.DASHBOARD_PORT || 3000);
const SCHEDULE_HOURS = [19]; // samakan dengan schedule.sh / schedule.ps1
const ENV_KEYS = ["UNSPLASH_ACCESS_KEY", "NINE_ROUTER_API_KEY", "FB_PAGE_ID", "FB_PAGE_ACCESS_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];

async function readOr(file, fallback) {
  try {
    return await readFile(join(ROOT, file), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// Hasil run terakhir = baris terakhir yang menandai sukses/gagal.
export function parseLog(text) {
  const lines = text.split("\n");
  let lastRun = null;
  for (const l of lines) {
    if (l.startsWith("Gagal posting:")) lastRun = { ok: false, message: l.slice("Gagal posting:".length).trim() };
    else if (l.includes("Posted!")) lastRun = { ok: true };
  }
  return { lastRun, tail: lines.filter(Boolean).slice(-60) };
}

export function nextRun(now = new Date()) {
  for (const day of [0, 1]) {
    for (const h of SCHEDULE_HOURS) {
      const d = new Date(now);
      d.setDate(d.getDate() + day);
      d.setHours(h, 0, 0, 0);
      if (d > now) return d.toISOString();
    }
  }
}

export async function readStatus(now = new Date()) {
  const history = JSON.parse(await readOr("history.json", "[]"));
  const log = parseLog((await readOr("post.log", "")).slice(-65536));
  const today = now.toDateString();
  return {
    now: now.toISOString(),
    total: history.length,
    today: history.filter((h) => new Date(h.date).toDateString() === today).length,
    lastPost: history.at(-1)?.date ?? null,
    nextRun: nextRun(now),
    lastRun: log.lastRun,
    log: log.tail,
    history: history.slice(-50).reverse(),
    config: Object.fromEntries(ENV_KEYS.map((k) => [k, Boolean(process.env[k])])),
  };
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(await readStatus()));
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(join(ROOT, "dashboard.html")));
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
  }
});

if (import.meta.main ?? process.argv[1]?.endsWith("dashboard.js")) {
  // Hanya localhost: history & log tidak diberi autentikasi.
  server.listen(PORT, "127.0.0.1", () => console.log(`Dashboard: http://127.0.0.1:${PORT}`));
}
