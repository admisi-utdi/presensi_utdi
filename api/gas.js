/**
 * /api/gas — satu-satunya jalur yang boleh dipakai frontend untuk bicara ke
 * Apps Script (database Google Sheet). Kenapa ada lapisan ini, bukan frontend
 * langsung fetch ke Apps Script?
 *
 * 1. GAS_WEBAPP_URL & API_SECRET disimpan sebagai environment variable di
 *    server Vercel — TIDAK PERNAH dikirim ke browser. Kalau frontend langsung
 *    yang menyimpan API_SECRET, siapa pun bisa buka DevTools dan mencurinya.
 * 2. ID token Google dari login user diverifikasi ULANG di sini (server-side)
 *    lewat Google, supaya kita yakin email yang dipakai untuk otorisasi di
 *    Apps Script itu benar-benar berasal dari login Google yang sah — bukan
 *    sekadar field JSON yang gampang dipalsukan dari sisi browser.
 *
 * Alur satu request:
 *   Browser --{idToken, fn, args}--> /api/gas (fungsi ini)
 *     -> verifyIdToken ke Google -> dapat email + domain (klaim "hd") yang TERVERIFIKASI
 *     -> tolak kalau bukan domain kampus
 *     -> teruskan ke Apps Script sebagai POST {secret, adminEmail, fn, args}
 *     -> balikin hasilnya apa adanya ke browser
 */

const { OAuth2Client } = require('google-auth-library');
const https = require('https');
const { URL } = require('url');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'utdi.ac.id').toLowerCase();
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const API_SECRET = process.env.API_SECRET;

const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

async function verifyGoogleIdToken(idToken) {
  if (!oauthClient) throw new Error('GOOGLE_CLIENT_ID belum diset di environment variable Vercel.');
  const ticket = await oauthClient.verifyIdToken({ idToken: idToken, audience: GOOGLE_CLIENT_ID });
  return ticket.getPayload();
}

/**
 * POST ke Apps Script Web App, dengan penanganan redirect MANUAL (bukan pasrah
 * ke default fetch). Ini penting: Apps Script Web App kadang membalas dengan
 * status redirect (3xx) ke URL eksekusi sebenarnya, dan sebagian implementasi
 * fetch akan mengubah method POST jadi GET saat mengikuti redirect semacam itu
 * (sesuai spek WHATWG fetch untuk kode status tertentu) — yang akan membuat
 * body request kita (JSON perintahnya) hilang begitu saja. Jadi di sini
 * redirect diikuti manual sambil tetap mengirim ulang method+body yang sama.
 */
const BROWSER_HEADERS = {
  'Accept': '*/*',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

/**
 * Kirim satu request POST/GET pakai modul https bawaan Node (bukan fetch/
 * undici). Beberapa pengguna melaporkan panggilan server-ke-server dari
 * platform serverless (Vercel/AWS) ke script.google.com kadang dibalas
 * halaman "verifikasi" oleh Google alih-alih menjalankan skrip, diduga
 * karena fingerprint HTTP client fetch modern (undici, HTTP/2, connection
 * reuse) dikenali berbeda dari browser biasa. https bawaan Node memakai
 * HTTP/1.1 polos tanpa reuse koneksi, lebih mendekati perilaku browser lama.
 */
function rawRequest(targetUrl, method, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(targetUrl);
    const headers = Object.assign({}, BROWSER_HEADERS);
    let data = null;
    if (method === 'POST') {
      data = Buffer.from(body, 'utf8');
      headers['Content-Type'] = 'text/plain;charset=utf-8';
      headers['Content-Length'] = String(data.length);
    }
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      agent: new https.Agent({ keepAlive: false })
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function postToAppsScript(payload) {
  let url = GAS_WEBAPP_URL;
  const body = JSON.stringify(payload);
  const maxHops = 5;
  let method = 'POST';
  let sendBody = body;

  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await rawRequest(url, method, method === 'POST' ? sendBody : null);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers['location'];
      if (!loc) throw new Error('Apps Script membalas redirect tanpa header Location.');
      url = loc.indexOf('http') === 0 ? loc : new URL(loc, url).toString();
      // Apps Script biasanya redirect ke URL eksekusi yang tetap menerima POST;
      // tetap kirim ulang method+body yang sama di hop berikutnya.
      continue;
    }

    const text = resp.text;
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error('Apps Script membalas status ' + resp.status + ': ' + text.slice(0, 800));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Respons Apps Script bukan JSON valid (kemungkinan URL GAS_WEBAPP_URL salah, atau butuh redeploy): ' + text.slice(0, 800));
    }
  }
  throw new Error('Terlalu banyak redirect saat memanggil Apps Script.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method tidak didukung, gunakan POST.' });
    return;
  }

  try {
    if (!GAS_WEBAPP_URL) throw new Error('GAS_WEBAPP_URL belum diset di environment variable Vercel.');
    if (!API_SECRET) throw new Error('API_SECRET belum diset di environment variable Vercel.');

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const idToken = body.idToken;
    const fn = body.fn;
    const args = Array.isArray(body.args) ? body.args : [];

    if (!idToken) {
      res.status(401).json({ ok: false, error: 'Belum login (tidak ada idToken).' });
      return;
    }
    if (!fn) {
      res.status(400).json({ ok: false, error: 'Parameter "fn" wajib diisi.' });
      return;
    }

    let payload;
    try {
      payload = await verifyGoogleIdToken(idToken);
    } catch (e) {
      res.status(401).json({ ok: false, error: 'Token Google tidak valid/kedaluwarsa, silakan login ulang.' });
      return;
    }

    if (!payload || !payload.email || payload.email_verified !== true) {
      res.status(401).json({ ok: false, error: 'Akun Google tidak terverifikasi.' });
      return;
    }
    const emailDomain = String(payload.email).split('@')[1] || '';
    if (emailDomain.toLowerCase() !== ALLOWED_DOMAIN) {
      res.status(403).json({ ok: false, error: 'Akun harus menggunakan domain @' + ALLOWED_DOMAIN + '.' });
      return;
    }

    const gasResult = await postToAppsScript({
      secret: API_SECRET,
      adminEmail: payload.email,
      fn: fn,
      args: args
    });

    res.status(200).json(gasResult);
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
};
