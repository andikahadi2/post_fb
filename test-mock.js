// Dimuat lewat `node --import` oleh test.js: mengganti fetch dengan respons palsu per skenario.
import { appendFileSync } from "node:fs";

const scenario = JSON.parse(process.env.MOCK_SCENARIO);
const calls = {};

function routeOf(url) {
  if (url.includes("news.google.com")) return "rss";
  if (url.includes("/chat/completions")) return "ai";
  if (url.includes("/download")) return "download";
  if (url.includes("/photos/random")) return `unsplash:${new URL(url).searchParams.get("query")}`;
  if (url.includes("/debug_token")) return "debug";
  if (url.includes("graph.facebook.com")) return "fb";
  if (url.includes("api.telegram.org")) return "telegram";
  return "unknown";
}

globalThis.fetch = async (input, opts = {}) => {
  const url = String(input);
  const route = routeOf(url);
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ route, url, body: opts.body ? String(opts.body) : null }) + "\n");

  let r = scenario[route] ?? (route.startsWith("unsplash:") ? scenario["unsplash:*"] : undefined);
  if (r === undefined) throw new Error(`mock: route belum didefinisikan: ${route}`);
  if (Array.isArray(r)) r = r[Math.min((calls[route] = (calls[route] ?? -1) + 1), r.length - 1)];

  if (r.throw) {
    const err = new TypeError("fetch failed");
    err.cause = { code: r.throw };
    throw err;
  }
  const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  return new Response(body, { status: r.status ?? 200 });
};
