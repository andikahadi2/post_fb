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
- Linux/macOS: `./schedule.sh` (cron setiap hari 19:00, plus catch-up 20:05–23:05 yang hanya jalan kalau posting 19:00 terlewat/gagal); hapus dengan `./schedule.sh --remove`.
- Windows: `powershell -ExecutionPolicy Bypass -File schedule.ps1`.

Log ada di `post.log`, riwayat topik/foto di `history.json`.

## Token permanen dengan satu perintah
Isi `FB_APP_ID` dan `FB_APP_SECRET` di `.env` (Meta for Developers → App → Settings → Basic), ambil user token baru dari Graph API Explorer, lalu:
`npm run fb-token -- <USER_TOKEN>` — menukar ke token Page permanen dan menulisnya ke `.env`.
Setiap posting, aplikasi mengecek masa berlaku token dan mengirim peringatan Telegram kalau kurang dari 3 hari.

## Ketahanan
- Request Unsplash dan 9Router diulang otomatis kalau error sementara (timeout, 5xx, 429).
- Kalau AI gagal total, dipakai caption cadangan sederhana supaya jadwal tidak bolong.
- Caption memuat nama media + domain sumber berita (link Google News terenkripsi & panjang, jadi tidak dipakai); keyword gambar dicoba satu per satu ke Unsplash.
- Kalau posting gagal, notifikasi Telegram dikirim (jika dikonfigurasi). Facebook tidak diulang otomatis agar tidak terjadi posting ganda.

## Belajar dari hasil posting
Tiap posting memakai salah satu dari 5 format caption (`CAPTION_FORMATS` di `post.js`). Setiap run, posting yang sudah >24 jam diukur sekali lewat Graph API (reaksi, komentar, share) dan skornya disimpan di `history.json` (`metrics.score` = reaksi + 3×komentar + 5×share).
Format dipilih berdasarkan data: format yang belum punya 2 posting terukur dicoba dulu, sesudah itu 75% memilih rata-rata skor tertinggi dan 25% acak. Dry-run tidak mengukur dan tidak mengubah history.

## Test
`npm test` (unit parser + end-to-end dengan fetch palsu).

## Dashboard pemantauan
`npm run dashboard` lalu buka http://127.0.0.1:3000 (ganti port lewat `DASHBOARD_PORT`).
Menampilkan status run terakhir (sukses/gagal), total & posting hari ini, jadwal berikutnya, riwayat posting dengan link ke Facebook, status konfigurasi, dan log terbaru; refresh otomatis tiap 30 detik.
Read-only dan hanya listen di localhost (tanpa autentikasi, jangan diekspos ke internet). Jam jadwal di dashboard (`SCHEDULE_HOURS` di `dashboard.js`) harus sama dengan jadwal cron.
