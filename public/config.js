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
window.GOOGLE_CLIENT_ID = 'GANTI_DENGAN_CLIENT_ID_GOOGLE_ANDA.apps.googleusercontent.com';
