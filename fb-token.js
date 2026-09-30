// Tukar user token jangka pendek jadi token Page permanen dan tulis ke .env.
// Pakai: npm run fb-token -- <SHORT_LIVED_USER_TOKEN>
// Ambil user token dari Graph API Explorer (izin: pages_show_list, pages_read_engagement, pages_manage_posts).
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

const G = "https://graph.facebook.com/v26.0";
const { FB_APP_ID, FB_APP_SECRET, FB_PAGE_ID } = process.env;
const shortToken = process.argv[2];

async function graph(path, params) {
  const url = new URL(`${G}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const data = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).json();
  if (data.error) throw new Error(data.error.message);
  return data;
}

async function main() {
  const missing = Object.entries({ FB_APP_ID, FB_APP_SECRET, FB_PAGE_ID, "argumen <user_token>": shortToken })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`Kurang: ${missing.join(", ")}. Isi FB_APP_ID & FB_APP_SECRET di .env (Meta for Developers -> App -> Settings -> Basic).`);

  const long = await graph("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: FB_APP_ID,
    client_secret: FB_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  const { access_token: pageToken, name } = await graph(`/${FB_PAGE_ID}`, { fields: "name,access_token", access_token: long.access_token });
  if (!pageToken) throw new Error("Akun ini tidak punya akses ke Page tersebut.");

  const { data } = await graph("/debug_token", { input_token: pageToken, access_token: pageToken });
  const env = readFileSync(".env", "utf8");
  writeFileSync(".env", env.replace(/^FB_PAGE_ACCESS_TOKEN=.*$/m, () => `FB_PAGE_ACCESS_TOKEN=${pageToken}`));
  console.log(`Token Page "${name}" disimpan ke .env. ${data.expires_at ? `Kedaluwarsa: ${new Date(data.expires_at * 1000).toLocaleString("id-ID")}` : "Tidak kedaluwarsa (permanen)."}`);
}

main().catch((err) => {
  console.error("Gagal:", err.message);
  process.exitCode = 1;
});
