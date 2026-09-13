# Si-PREDI — Frontend Vercel

Frontend baru Si-PREDI yang dihosting di Vercel, supaya Mode Scan (kamera)
bisa berfungsi — ini tidak pernah bisa jalan di versi lama (Apps Script Web
App) karena Google membungkusnya dalam iframe yang tidak diizinkan mengakses
kamera sama sekali.

Database & seluruh logic bisnis (checkIn, generate kode, kirim email, dsb)
**tetap** ada di Google Sheet + Apps Script yang sudah ada — folder
`PRESENSI` yang biasa Anda `clasp push` / `clasp deploy`. Project ini
HANYA tampilannya, yang bicara ke Apps Script itu lewat sebuah API.

## Struktur project

```
presensi_utdi/
├── api/
│   └── gas.js          <- serverless function: proxy ke Apps Script + verifikasi login Google
├── public/
│   ├── index.html       <- tampilan utama (dulu Index.html)
│   ├── styles.css        <- dulu Styles.html
│   ├── app.js            <- dulu Scripts.html
│   ├── config.js         <- GOOGLE_CLIENT_ID (boleh publik)
│   └── template_peserta.csv
├── package.json
├── vercel.json
└── README.md (file ini)
```

## Langkah setup (urutkan seperti ini)

### 1. Set API_SECRET di Apps Script

Ini kunci rahasia supaya cuma Vercel (backend-nya, bukan browser) yang bisa
memanggil API Apps Script.

1. Buka project Apps Script (script.google.com) → ikon gerigi ⚙️ **Project Settings**.
2. Scroll ke **Script Properties** → **Add script property**.
3. Property: `API_SECRET`, Value: string acak yang panjang & rahasia (contoh:
   buka https://1password.com/password-generator/ atau ketik sembarang teks
   panjang minimal 32 karakter, campur huruf-angka). **Simpan baik-baik**,
   nilai yang SAMA PERSIS dipakai lagi di langkah 4.
4. Klik **Save script properties**.

### 2. Push & deploy ulang Apps Script (sudah ada perubahan dari saya)

Di folder `PRESENSI` seperti biasa:
```
clasp push -f
clasp deploy -i AKfycbwifCBUnoB64eF6rXF92y4jjKjVpTigjZI4TGXnDiRax9SrWxVwAXi7EdzrUd0UjsEaTQ
```

**PENTING — cek manual setelah push:** karena `appsscript.json` sekarang
mengubah "Execute as" jadi **Me** dan "Who has access" jadi **Anyone, even
anonymous**, terkadang `clasp deploy` ke deployment ID yang SUDAH ADA tidak
otomatis menerapkan 2 setting itu. Jadi setelah push:
1. Di editor Apps Script, klik **Deploy → Manage deployments**.
2. Pilih deployment aktif Anda → klik ikon pensil (edit).
3. Pastikan:
   - **Execute as**: `Me (email Anda)`
   - **Who has access**: `Anyone` (di beberapa akun tertulis "Anyone, even anonymous")
4. Klik **Deploy** untuk menyimpan.

Ini konsekuensi wajib supaya Vercel (yang memanggil tanpa sesi login Google
sama sekali) bisa jalan — sebagai gantinya, sekarang SEMUA admin otomatis
bisa akses Sheet-nya tanpa perlu di-share satu-satu lagi (karena selalu
jalan sebagai 1 akun tetap = akun yang deploy).

### 3. Buat Google OAuth Client ID (untuk tombol "Login dengan Google")

1. Buka https://console.cloud.google.com/apis/credentials
2. Pilih/buat project (boleh project baru khusus Si-PREDI).
3. **Create Credentials → OAuth client ID**.
   - Kalau diminta setup "OAuth consent screen" dulu: User Type **Internal**
     (kalau akun Google Workspace UTDI Anda mendukung ini — artinya hanya
     akun @utdi.ac.id yang bisa login) atau **External** kalau tidak ada
     opsi Internal (tetap aman karena kita filter domain di kode).
   - Application type: **Web application**.
   - Authorized JavaScript origins: isi URL Vercel Anda nanti, contoh
     `https://presensi-utdi.vercel.app` (bisa ditambah belakangan setelah
     tahu URL pastinya — lihat langkah 5).
4. Setelah dibuat, copy **Client ID**-nya (formatnya
   `xxxxx.apps.googleusercontent.com`). Simpan, dipakai di langkah 4 & 6.

### 4. Push project ini ke GitHub

Repo Anda sudah siap di `https://github.com/admisi-utdi/presensi_utdi.git`.
Dari folder project ini (`presensi_utdi`), jalankan:

```
git init
git add .
git commit -m "Initial commit: Si-PREDI frontend Vercel"
git branch -M main
git remote add origin https://github.com/admisi-utdi/presensi_utdi.git
git push -u origin main
```

### 5. Import ke Vercel

1. Buka https://vercel.com/new, pilih **Import Git Repository**, cari
   `admisi-utdi/presensi_utdi`.
2. Framework Preset: biarkan **Other** (tidak perlu Next.js dkk, project ini
   sengaja tanpa framework).
3. Sebelum klik Deploy, buka bagian **Environment Variables**, isi 4 ini:

   | Name | Value |
   |---|---|
   | `GAS_WEBAPP_URL` | URL exec Apps Script Anda, contoh: `https://script.google.com/a/macros/utdi.ac.id/s/AKfycbwifCBUnoB64eF6rXF92y4jjKjVpTigjZI4TGXnDiRax9SrWxVwAXi7EdzrUd0UjsEaTQ/exec` |
   | `API_SECRET` | Persis sama dengan `API_SECRET` di Script Properties (langkah 1) |
   | `GOOGLE_CLIENT_ID` | Client ID dari langkah 3 |
   | `ALLOWED_DOMAIN` | `utdi.ac.id` |

4. Klik **Deploy**. Tunggu sampai selesai, Vercel akan kasih URL, contoh
   `https://presensi-utdi.vercel.app`.

### 6. Sambungkan URL Vercel ke Google Cloud & config.js

1. Balik ke https://console.cloud.google.com/apis/credentials, buka OAuth
   Client ID yang dibuat di langkah 3, tambahkan URL Vercel Anda ke
   **Authorized JavaScript origins** (persis, tanpa slash di akhir), Save.
2. Edit `public/config.js` di repo, isi `window.GOOGLE_CLIENT_ID` dengan
   Client ID yang sama dari langkah 3 (menggantikan placeholder), lalu:
   ```
   git add public/config.js
   git commit -m "Isi GOOGLE_CLIENT_ID"
   git push
   ```
   Vercel otomatis redeploy setiap kali ada push ke `main`.

### 7. Coba

Buka URL Vercel-nya, klik tombol **Sign in with Google**, login pakai akun
admin @utdi.ac.id yang sudah terdaftar di sheet Admin. Kalau berhasil masuk,
coba buka menu Presensi → Mode Scan — kamera seharusnya sekarang bisa
diakses normal (akan muncul prompt izin kamera dari browser, beda dari versi
Apps Script yang dulu langsung gagal tanpa prompt sama sekali).

## Kalau ada error

- **"GOOGLE_CLIENT_ID belum diisi..."** di layar login → langkah 6 belum
  selesai (config.js masih placeholder).
- **"Token Google tidak valid/kedaluwarsa"** terus-menerus → cek Authorized
  JavaScript origins di Google Cloud Console sudah persis sama dengan URL
  Vercel (termasuk https://, tanpa trailing slash).
- **"Akses ditolak: secret tidak valid."** → `API_SECRET` di Vercel env var
  tidak sama persis dengan yang di Script Properties Apps Script.
- **"GAS_WEBAPP_URL belum diset..."** / **"Respons Apps Script tidak
  valid..."** → cek env var `GAS_WEBAPP_URL` di Vercel, dan pastikan sudah
  redeploy Apps Script (langkah 2) setelah appsscript.json diubah.
- Login berhasil tapi masuk ke pesan **"belum terdaftar sebagai admin"** →
  email itu belum ada di sheet Admin (atau `AKTIF` bukan "Ya").
