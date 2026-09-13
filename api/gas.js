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
async function postToAppsScript(payload) {
  let url = GAS_WEBAPP_URL;
  const body = JSON.stringify(payload);
  const maxHops = 5;

  for (let hop = 0; hop < maxHops; hop++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'manual'
    });

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('Apps Script membalas redirect tanpa header Location.');
      url = loc;
      continue;
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error('Apps Script membalas status ' + resp.status + ': ' + text.slice(0, 300));
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Respons Apps Script bukan JSON valid (kemungkinan URL GAS_WEBAPP_URL salah, atau butuh redeploy): ' + text.slice(0, 300));
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
