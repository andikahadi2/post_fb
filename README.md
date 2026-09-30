# AI Post FB

Auto-post konten otomotif ke Facebook Page: topik dari Google News RSS → caption AI (9Router) → foto Unsplash → Graph API.
Butuh Node.js 20+.

## Setup
1. `npm install`
2. `cp .env.example .env` lalu isi:
   - `UNSPLASH_ACCESS_KEY` — buat app di https://unsplash.com/developers.
   - `NINE_ROUTER_API_KEY` — dari dashboard 9Router (harus jalan di `NINE_ROUTER_BASE_URL`, default `localhost:20128`).
   - `FB_PAGE_ID` dan `FB_PAGE_ACCESS_TOKEN` — lihat bagian token di bawah.
   - `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (opsional) — notifikasi kalau posting gagal.
3. `npm run dry` — coba tanpa posting ke Facebook.
4. `npm run post` — posting sungguhan.

## Token Facebook (tidak kedaluwarsa)
1. Di https://developers.facebook.com buat app, tambahkan izin `pages_manage_posts` dan `pages_read_engagement`.
2. Di Graph API Explorer, generate **User token** dengan izin itu, lalu tukar jadi long-lived:
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=USER_TOKEN`
3. Ambil page token: `GET /me/accounts?access_token=LONG_LIVED_USER_TOKEN`. Page token dari user token long-lived **tidak kedaluwarsa**. Pakai `access_token` dan `id` halaman itu untuk `.env`.

## Jadwal
- Linux/macOS: `./schedule.sh` (cron 08:00 & 19:00); hapus dengan `./schedule.sh --remove`.
- Windows: `powershell -ExecutionPolicy Bypass -File schedule.ps1`.

Log ada di `post.log`, riwayat topik/foto di `history.json`.

## Ketahanan
- Request Unsplash dan 9Router diulang otomatis kalau error sementara (timeout, 5xx, 429).
- Kalau AI gagal total, dipakai caption cadangan sederhana supaya jadwal tidak bolong.
- Kalau posting gagal, notifikasi Telegram dikirim (jika dikonfigurasi). Facebook tidak diulang otomatis agar tidak terjadi posting ganda.

## Test
`npm test` (unit parser + end-to-end dengan fetch palsu).
