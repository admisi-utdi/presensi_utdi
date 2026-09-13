// Konfigurasi PUBLIK untuk frontend (aman ada di sini / di GitHub — Client ID
// Google OAuth memang didesain untuk terlihat publik, BEDA dengan API_SECRET
// yang harus selalu jadi environment variable di server Vercel, tidak pernah
// ditulis di file ini atau file manapun yang dikirim ke browser).
//
// Cara isi GOOGLE_CLIENT_ID:
// 1. Buka https://console.cloud.google.com/apis/credentials (pilih/buat project)
// 2. Create Credentials > OAuth client ID > Application type: "Web application"
// 3. Authorized JavaScript origins: isi dengan URL Vercel Anda, contoh:
//      https://presensi-utdi.vercel.app
//    (tambahkan lagi tiap kali ada domain/preview URL baru yang dipakai)
// 4. Copy "Client ID" yang dihasilkan (formatnya "xxxx.apps.googleusercontent.com")
//    lalu tempel di bawah ini menggantikan placeholder.
window.GOOGLE_CLIENT_ID = '574855682295-vj3k3efdods3eft98vu45rsosv0qj9dt.apps.googleusercontent.com';

// URL Web App Apps Script (boleh publik, ini bukan rahasia — sama seperti
// URL "exec" yang dulu dipakai langsung di browser untuk versi lama).
// Browser sekarang memanggil Apps Script LANGSUNG memakai URL ini (bukan
// lewat server Vercel lagi), karena panggilan server-ke-server dari Vercel
// ke script.google.com ternyata sering diblokir Google.
window.GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbwifCBUnoB64eF6rXF92y4jjKjVpTigjZI4TGXnDiRax9SrWxVwAXi7EdzrUd0UjsEaTQ/exec';
