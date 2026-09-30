// Dimuat lewat `node --import` oleh test.js: mengganti fetch dengan respons palsu per skenario.
import { appendFileSync } from "node:fs";

const scenario = JSON.parse(process.env.MOCK_SCENARIO);
let aiCalls = 0;

function routeOf(url) {
  if (url.includes("news.google.com")) return "rss";
  if (url.includes("/chat/completions")) return "ai";
  if (url.includes("/download")) return "download";
  if (url.includes("/photos/random")) return `unsplash:${new URL(url).searchParams.get("query")}`;
  if (url.includes("graph.facebook.com")) return "fb";
  return "unknown";
}

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const route = routeOf(url);
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ route, url, body: opts.body ? String(opts.body) : null }) + "\n");

  let r = scenario[route] ?? (route.startsWith("unsplash:") ? scenario["unsplash:*"] : undefined);
  if (r === undefined) throw new Error(`mock: route belum didefinisikan: ${route}`);
  if (route === "ai" && Array.isArray(r)) r = r[Math.min(aiCalls++, r.length - 1)];

  if (r.throw) {
    const err = new TypeError("fetch failed");
    err.cause = { code: r.throw };
    throw err;
  }
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status ?? 200 });
};
