// ============================================================
// Si-PREDI — frontend Vercel
// Porting dari versi Apps Script Web App: logic-nya nyaris sama persis,
// yang beda cuma cara bicara ke server (dulu google.script.run, sekarang
// fetch ke /api/gas) dan ada lapisan login Google (GIS) di depan karena
// Apps Script tidak lagi menyediakan sesi login secara otomatis.
// ============================================================

// ---------- AUTH (Google Identity Services) ----------
let idToken_ = sessionStorage.getItem('sipredi_id_token') || null;
let currentUserEmail_ = sessionStorage.getItem('sipredi_email') || '';

function handleCredentialResponse(response) {
  idToken_ = response.credential;
  sessionStorage.setItem('sipredi_id_token', idToken_);
  verifySessionAndEnter_();
}

function initGoogleSignIn_() {
  if (!window.GOOGLE_CLIENT_ID || window.GOOGLE_CLIENT_ID.indexOf('GANTI_DENGAN') === 0) {
    document.getElementById('login-error').textContent =
      'GOOGLE_CLIENT_ID belum diisi di public/config.js. Lihat README untuk cara membuat OAuth Client ID di Google Cloud Console.';
    document.getElementById('login-error').hidden = false;
    return;
  }
  // Script https://accounts.google.com/gsi/client dimuat dengan `async`,
  // jadi bisa saja belum selesai ter-download saat titik ini dijalankan.
  // Tunggu sampai window.google benar-benar tersedia (maks ~5 detik).
  if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
    if (!initGoogleSignIn_._tries) initGoogleSignIn_._tries = 0;
    initGoogleSignIn_._tries++;
    if (initGoogleSignIn_._tries > 50) {
      document.getElementById('login-error').textContent =
        'Gagal memuat script Google Sign-In. Cek koneksi internet Anda lalu muat ulang halaman.';
      document.getElementById('login-error').hidden = false;
      return;
    }
    setTimeout(initGoogleSignIn_, 100);
    return;
  }
  google.accounts.id.initialize({
    client_id: window.GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse
  });
  google.accounts.id.renderButton(
    document.getElementById('gis-button-wrap'),
    { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' }
  );
}

function showLoginScreen_(message) {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
  if (message) {
    document.getElementById('login-error').textContent = message;
    document.getElementById('login-error').hidden = false;
  }
}

function logout() {
  idToken_ = null;
  currentUserEmail_ = '';
  sessionStorage.removeItem('sipredi_id_token');
  sessionStorage.removeItem('sipredi_email');
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  showLoginScreen_('');
  document.getElementById('login-error').hidden = true;
}

// Dipanggil saat load pertama (kalau ada token tersimpan) atau tepat setelah login baru.
function verifySessionAndEnter_() {
  if (!idToken_) { showLoginScreen_(''); return; }
  showLoading('Memeriksa akun...');
  callGas('getSessionInfo', []).then(function (info) {
    hideLoading();
    if (!info || !info.email) {
      showLoginScreen_('Sesi tidak valid, silakan login ulang.');
      return;
    }
    if (!info.isAdmin) {
      showLoginScreen_('Akun ' + info.email + ' berhasil login, tapi belum terdaftar sebagai admin Si-PREDI. Minta admin aktif menambahkan email ini lewat menu Kelola Admin.');
      return;
    }
    currentUserEmail_ = info.email;
    currentUserRole_ = info.role || 'Admin';
    currentUserNama_ = info.namaAdmin || info.email;
    sessionStorage.setItem('sipredi_email', currentUserEmail_);
    document.getElementById('login-screen').hidden = true;
    document.getElementById('app-shell').hidden = false;
    document.getElementById('user-email').textContent = currentUserEmail_;
    applyRoleRestrictions_();
    if (currentUserRole_ === 'Operator') {
      showPage('presensi');
    } else {
      loadDashboard();
    }
  }).catch(function (err) {
    hideLoading();
    showLoginScreen_('Gagal memeriksa sesi: ' + (err.message || err));
  });
}

let currentEventId = null;   // event yang dipilih di halaman Peserta
let scanEventId = null;      // event yang dipilih di halaman Presensi
let html5QrCode = null;
let currentMode = 'ketik';
let currentUserRole_ = 'Admin'; // 'Admin' (akses penuh) atau 'Operator' (hanya Presensi/Scan)
let currentUserNama_ = ''; // nama petugas yang sedang login, dipakai untuk tampilan optimistik sebelum data server dimuat ulang

/**
 * Operator hanya boleh melihat & membuka menu Presensi (Pintu Masuk) — menu
 * lain (Dashboard, Kelola Event, Kelola Peserta, Kelola Admin) disembunyikan
 * dari sidebar. Ini pelengkap tampilan; pembatasan yang SEBENARNYA tetap
 * dijaga di server (lihat requireFullAdmin_ di GasApi.gs/AdminService.gs).
 */
function applyRoleRestrictions_() {
  const isOperator = currentUserRole_ === 'Operator';
  document.querySelectorAll('.navitem.full-admin-only').forEach(function (el) {
    el.hidden = isOperator;
  });
}
let allEventsCache = [];
let resultAutoTimer = null;

// ============================================================
// GENERIC SERVER CALL — dulu lewat google.script.run (RPC bawaan Apps
// Script), lalu sempat lewat proxy server Vercel (/api/gas), TAPI panggilan
// server-ke-server dari Vercel ke script.google.com ternyata sering diblokir
// Google (dianggap trafik data center mencurigakan). Sekarang browser
// memanggil Apps Script LANGSUNG (terbukti selalu berhasil di uji coba),
// dan Apps Script sendiri yang memverifikasi idToken ke server Google
// (lihat GasApi.gs / doPost -> verifyGoogleIdToken_).
// gsRun() menambahkan loading overlay otomatis, callGas() tidak (dipakai
// untuk panggilan "diam-diam" seperti cek sesi atau fire-and-forget).
// ============================================================
function callGas(fnName, args) {
  if (!window.GAS_WEBAPP_URL) {
    return Promise.reject(new Error('GAS_WEBAPP_URL belum diisi di public/config.js.'));
  }
  return fetch(window.GAS_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ idToken: idToken_, fn: fnName, args: args || [] })
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || res.ok !== true) {
        const msg = (res && res.error) ? res.error : 'Terjadi kesalahan tidak diketahui.';
        throw new Error(msg);
      }
      return res.data;
    });
}

function gsRun(fnName, args, loadingText) {
  showLoading(loadingText);
  return callGas(fnName, args).then(
    function (data) { hideLoading(); return data; },
    function (err) { hideLoading(); throw err; }
  );
}

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || 'Memproses...';
  document.getElementById('loading-overlay').classList.add('show');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}

// ============================================================
// RESULT MODAL — dipakai konsisten untuk semua notifikasi
// sukses / gagal / peringatan di seluruh aplikasi
// ============================================================
function showResultModal(type, title, message, autoCloseMs) {
  const icon = document.getElementById('result-icon');
  icon.className = 'result-icon ' + type;
  icon.textContent = type === 'success' ? '✓' : (type === 'warn' ? '!' : '✕');
  document.getElementById('result-title').textContent = title;
  document.getElementById('result-message').textContent = message || '';
  document.getElementById('result-modal-backdrop').classList.add('open');

  if (resultAutoTimer) clearTimeout(resultAutoTimer);
  if (autoCloseMs) {
    resultAutoTimer = setTimeout(closeResultModal, autoCloseMs);
  }
}
function closeResultModal() {
  document.getElementById('result-modal-backdrop').classList.remove('open');
  if (resultAutoTimer) { clearTimeout(resultAutoTimer); resultAutoTimer = null; }
  // Kalau modal ini yang menghentikan sementara kamera scan (lihat
  // showScanResultModal_), lanjutkan lagi kamera begitu modal ditutup.
  if (html5QrCode && scannerPausedForModal_) {
    scannerPausedForModal_ = false;
    try { html5QrCode.resume(); } catch (e) { /* abaikan kalau scanner sudah berhenti total */ }
  }
}

let scannerPausedForModal_ = false;

/**
 * Notifikasi hasil scan yang MENONJOL (modal penuh, harus diklik OK) supaya
 * operator tidak sampai kelewat lihat status sukses/gagal — sebelumnya cuma
 * kotak kecil di bawah kamera yang gampang tidak disadari di layar HP.
 * Kamera dijeda otomatis selama modal terbuka supaya tidak nge-scan lagi
 * sebelum operator menekan OK.
 */
function showScanResultModal_(res) {
  if (html5QrCode) {
    try { html5QrCode.pause(true); scannerPausedForModal_ = true; } catch (e) { /* kamera mungkin belum aktif */ }
  }
  if (res.ok) {
    showResultModal('success', '✅ ' + (res.nama || 'Berhasil'),
      (res.namaEvent ? res.namaEvent + ' — ' : '') + 'Presensi tercatat.');
  } else if (res.duplicateScan) {
    showResultModal('warn', 'Tunggu Sebentar', res.message);
  } else if (res.outsideWindow) {
    showResultModal('warn', 'Belum/Sudah Waktunya', res.message);
  } else if (res.eventMismatch) {
    showResultModal('warn', 'Event Tidak Sesuai', res.message);
  } else if (res.sudahHadir) {
    showResultModal('warn', res.nama || 'Sudah Presensi', 'Sudah presensi sebelumnya.');
  } else {
    showResultModal('error', 'Gagal', res.message);
  }
}
function showSuccess(message, title) { showResultModal('success', title || 'Berhasil', message, 1800); }
function showErrorModal(err) { showResultModal('error', 'Gagal', (err && err.message) ? err.message : String(err)); }

// ============================================================
// CONFIRM MODAL — pengganti confirm() bawaan browser (yang tampilannya
// tidak konsisten dan tidak bisa distyle) supaya SEMUA aksi berisiko
// (hapus event/peserta, nonaktifkan admin, kirim massal) pakai modal
// yang sama gaya-nya dengan modal sukses/gagal.
// ============================================================
let confirmResolve_ = null;
function showConfirm(message, title) {
  document.getElementById('confirm-title').textContent = title || 'Konfirmasi';
  document.getElementById('confirm-message').textContent = message || '';
  document.getElementById('confirm-modal-backdrop').classList.add('open');
  return new Promise(function (resolve) { confirmResolve_ = resolve; });
}
function closeConfirmModal() {
  document.getElementById('confirm-modal-backdrop').classList.remove('open');
  if (confirmResolve_) { confirmResolve_(false); confirmResolve_ = null; }
}
function confirmModalOk_() {
  document.getElementById('confirm-modal-backdrop').classList.remove('open');
  if (confirmResolve_) { confirmResolve_(true); confirmResolve_ = null; }
}

// ---------- DANGER CONFIRM (HAPUS SEMUA) ----------
let dangerResolve_ = null;
let dangerWord_ = '';
function showDangerConfirm(message, title, confirmWord) {
  dangerWord_ = confirmWord || 'HAPUS';
  document.getElementById('danger-title').textContent = title || 'Hapus Semua';
  document.getElementById('danger-message').textContent = message || '';
  document.getElementById('danger-word-label').textContent = '"' + dangerWord_ + '"';
  const input = document.getElementById('danger-confirm-input');
  input.value = '';
  document.getElementById('danger-ok-btn').disabled = true;
  document.getElementById('danger-modal-backdrop').classList.add('open');
  setTimeout(function () { input.focus(); }, 50);
  return new Promise(function (resolve) { dangerResolve_ = resolve; });
}
function onDangerInputChange_() {
  const val = document.getElementById('danger-confirm-input').value.trim().toUpperCase();
  document.getElementById('danger-ok-btn').disabled = (val !== dangerWord_.toUpperCase());
}
function closeDangerModal() {
  document.getElementById('danger-modal-backdrop').classList.remove('open');
  if (dangerResolve_) { dangerResolve_(false); dangerResolve_ = null; }
}
function dangerModalOk_() {
  document.getElementById('danger-modal-backdrop').classList.remove('open');
  if (dangerResolve_) { dangerResolve_(true); dangerResolve_ = null; }
}

// ---------- NAVIGASI ----------
document.querySelectorAll('.navitem').forEach(function (el) {
  el.addEventListener('click', function () { showPage(el.dataset.page); });
});

function showPage(page) {
  document.querySelectorAll('.navitem').forEach(function (el) {
    el.classList.toggle('active', el.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(function (el) {
    el.classList.toggle('active', el.id === 'page-' + page);
  });
  if (page === 'dashboard') loadDashboard();
  if (page === 'events') loadEvents();
  if (page === 'peserta') loadEventOptions();
  if (page === 'presensi') { loadPresensiEventOptions(); stopScanner(); focusScannerInput_(); }
  if (page === 'linkpresensi') loadLinkPresensiEventOptions();
  if (page === 'laporan') loadLaporanEventOptions();
  if (page === 'admin') loadAdmins();
}

function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function openModal(id) { document.getElementById(id).classList.add('open'); }

// ---------- DASHBOARD ----------
function loadDashboard() {
  document.getElementById('dashboard-content').innerHTML = '<p class="empty">Memuat...</p>';
  gsRun('getDashboardSummary', [], 'Memuat dashboard...')
    .then(renderDashboard)
    .catch(function (err) {
      document.getElementById('dashboard-content').innerHTML = '<div class="card"><div class="empty">Gagal memuat data: ' + esc(err.message || err) + '</div></div>';
    });
}

function renderDashboard(list) {
  list = list || [];
  if (!list.length) {
    document.getElementById('dashboard-content').innerHTML = '<div class="card"><div class="empty">Belum ada event.</div></div>';
    return;
  }
  const totalEvent = list.length;
  const totalPeserta = list.reduce(function (a, e) { return a + e.total; }, 0);
  const totalHadir = list.reduce(function (a, e) { return a + e.hadir; }, 0);

  let html = '<div class="grid-stats">' +
    statCard(totalEvent, 'Total Event') +
    statCard(totalPeserta, 'Total Peserta Terdaftar') +
    statCard(totalHadir, 'Total Hadir') +
    statCard(totalPeserta - totalHadir, 'Belum Hadir') +
    '</div><div class="card"><table><thead><tr><th>Event</th><th>Tanggal</th><th>Status</th><th>Hadir / Total</th></tr></thead><tbody>';

  list.forEach(function (e) {
    html += '<tr><td>' + esc(e.namaEvent) + '</td><td>' + fmtDate(e.tanggal) + '</td>' +
      '<td>' + badgeStatus(e.status) + '</td><td>' + e.hadir + ' / ' + e.total + '</td></tr>';
  });
  html += '</tbody></table></div>';
  document.getElementById('dashboard-content').innerHTML = html;
}

function statCard(num, label) {
  return '<div class="stat"><div class="num">' + num + '</div><div class="label">' + label + '</div></div>';
}

// ---------- EVENTS ----------
function loadEvents() {
  gsRun('getAllEvents', [], 'Memuat event...')
    .then(function (list) { allEventsCache = list || []; renderEvents(allEventsCache); })
    .catch(showErrorModal);
}

function renderEvents(list) {
  list = list || [];
  const tbody = document.getElementById('events-table');
  document.getElementById('events-empty').style.display = list.length ? 'none' : 'block';
  tbody.innerHTML = list.map(function (e, i) {
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + esc(e.NAMA_EVENT) + '</td>' +
      '<td>' + fmtDate(e.TANGGAL) + '</td>' +
      '<td>' + esc(e.JAM_MULAI) + (e.JAM_SELESAI ? ' - ' + esc(e.JAM_SELESAI) : '') + '</td>' +
      '<td>' + esc(e.LOKASI) + '</td>' +
      '<td>' + badgeStatus(e.STATUS) + '</td>' +
      '<td class="row">' +
        '<button class="btn secondary sm" onclick="editEvent(\'' + e.ID_EVENT + '\')">Edit</button>' +
        '<button class="btn danger sm" onclick="removeEvent(\'' + e.ID_EVENT + '\')">Hapus</button>' +
      '</td></tr>';
  }).join('');
}

function openEventModal() {
  document.getElementById('event-modal-title').textContent = 'Event Baru';
  document.getElementById('event-id').value = '';
  ['event-nama','event-tanggal','event-jam-mulai','event-jam-selesai','event-lokasi','event-deskripsi'].forEach(function(id){ document.getElementById(id).value = ''; });
  openModal('modal-event');
}

function editEvent(id) {
  const e = allEventsCache.find(function (x) { return x.ID_EVENT === id; });
  if (!e) return;
  document.getElementById('event-modal-title').textContent = 'Edit Event';
  document.getElementById('event-id').value = e.ID_EVENT;
  document.getElementById('event-nama').value = e.NAMA_EVENT;
  document.getElementById('event-tanggal').value = toDateInput(e.TANGGAL);
  document.getElementById('event-jam-mulai').value = e.JAM_MULAI;
  document.getElementById('event-jam-selesai').value = e.JAM_SELESAI;
  document.getElementById('event-lokasi').value = e.LOKASI;
  document.getElementById('event-deskripsi').value = e.DESKRIPSI || '';
  openModal('modal-event');
}

function saveEvent() {
  const id = document.getElementById('event-id').value;
  const data = {
    namaEvent: document.getElementById('event-nama').value.trim(),
    tanggal: document.getElementById('event-tanggal').value,
    jamMulai: document.getElementById('event-jam-mulai').value,
    jamSelesai: document.getElementById('event-jam-selesai').value,
    lokasi: document.getElementById('event-lokasi').value.trim(),
    deskripsi: document.getElementById('event-deskripsi').value.trim()
  };
  if (!data.namaEvent || !data.tanggal) { showResultModal('warn', 'Belum lengkap', 'Nama & tanggal event wajib diisi.'); return; }

  const task = id
    ? gsRun('updateEvent', [id, Object.assign(data, { status: 'Aktif' })], 'Menyimpan perubahan...')
    : gsRun('createEvent', [data], 'Membuat event...');

  task.then(function () {
    closeModal('modal-event');
    showSuccess(id ? 'Event berhasil diperbarui.' : 'Event baru berhasil dibuat.');
    loadEvents();
  }).catch(showErrorModal);
}

function removeEvent(id) {
  showConfirm('Hapus event ini? Data peserta di dalamnya tidak ikut terhapus.', 'Hapus Event').then(function (ok) {
    if (!ok) return;
    gsRun('deleteEvent', [id], 'Menghapus event...')
      .then(function () { showSuccess('Event berhasil dihapus.'); loadEvents(); })
      .catch(showErrorModal);
  });
}

function hapusSemuaEvent() {
  showDangerConfirm(
    'Semua event akan dihapus permanen. Data peserta yang sudah terdaftar TIDAK ikut terhapus (masih tersimpan), tapi jadi tidak terkait event manapun. Aksi ini tidak bisa dibatalkan.',
    'Hapus Semua Event',
    'HAPUS SEMUA EVENT'
  ).then(function (ok) {
    if (!ok) return;
    gsRun('deleteAllEvents', [], 'Menghapus semua event...')
      .then(function () { showSuccess('Semua event berhasil dihapus.'); loadEvents(); loadDashboard(); })
      .catch(showErrorModal);
  });
}

// ---------- PESERTA ----------
function loadEventOptions() {
  gsRun('getAllEvents', [], 'Memuat event...').then(function (list) {
    allEventsCache = list || [];
    const sel = document.getElementById('peserta-event-select');
    const optSemua = '<option value="">— Semua Event —</option>';
    const optEvents = allEventsCache.map(function (e) { return '<option value="' + e.ID_EVENT + '">' + esc(e.NAMA_EVENT) + ' (' + fmtDate(e.TANGGAL) + ')</option>'; }).join('');
    sel.innerHTML = optSemua + optEvents;
    if (allEventsCache.length) {
      currentEventId = allEventsCache[0].ID_EVENT;
      sel.value = currentEventId;
      loadPeserta();
    } else {
      currentEventId = '';
      document.getElementById('peserta-table').innerHTML = '';
      document.getElementById('peserta-empty').style.display = 'block';
    }
  }).catch(showErrorModal);
}

function eventNameById_(id) {
  const e = allEventsCache.find(function (x) { return x.ID_EVENT === id; });
  return e ? e.NAMA_EVENT : '-';
}

let pesertaListCache_ = [];

function loadPeserta() {
  currentEventId = document.getElementById('peserta-event-select').value;
  updatePesertaBanner_();
  const task = currentEventId
    ? gsRun('getParticipantsByEvent', [currentEventId], 'Memuat peserta...')
    : gsRun('getAllParticipantsAll', [], 'Memuat semua peserta...');
  task.then(function (list) {
    pesertaListCache_ = list || [];
    applyPesertaFilter();
  }).catch(showErrorModal);
}

function applyPesertaFilter() {
  const mode = document.getElementById('peserta-filter-kirim').value;
  let list = pesertaListCache_;
  if (mode === 'ya') list = list.filter(function (p) { return p.EMAIL_TERKIRIM === 'Ya'; });
  else if (mode === 'tidak') list = list.filter(function (p) { return p.EMAIL_TERKIRIM !== 'Ya'; });
  renderPeserta(list);
}

function updatePesertaBanner_() {
  const banner = document.getElementById('peserta-event-banner');
  const e = currentEventId ? allEventsCache.find(function (x) { return x.ID_EVENT === currentEventId; }) : null;
  if (!e) { banner.classList.remove('show'); return; }
  document.getElementById('peserta-eb-name').textContent = e.NAMA_EVENT;
  const meta = [fmtDate(e.TANGGAL)];
  if (e.JAM_MULAI) meta.push(e.JAM_MULAI + (e.JAM_SELESAI ? '–' + e.JAM_SELESAI : ''));
  if (e.LOKASI) meta.push(e.LOKASI);
  document.getElementById('peserta-eb-meta').textContent = meta.join('  •  ');
  document.getElementById('peserta-eb-badge').textContent = e.STATUS || '';
  banner.classList.add('show');
}

function renderPeserta(list) {
  const emptyEl = document.getElementById('peserta-empty');
  emptyEl.style.display = list.length ? 'none' : 'block';
  if (!list.length) {
    emptyEl.textContent = pesertaListCache_.length
      ? 'Tidak ada peserta dengan status kirim ini. Coba ganti filter di atas.'
      : 'Belum ada peserta di event ini.';
  }
  document.getElementById('peserta-table').innerHTML = list.map(function (p, i) {
    const hadir = p.STATUS_HADIR === 'Hadir';
    const terkirim = p.EMAIL_TERKIRIM === 'Ya';
    const emailBtnLabel = terkirim ? '↻ Kirim Ulang' : '✉ Kirim Email';
    const emailBtnClass = terkirim ? 'btn secondary sm' : 'btn sm';
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + avatarChip(p.NAMA, p.EMAIL) + '</td>' +
      '<td><span class="badge aktif">' + esc(eventNameById_(p.ID_EVENT)) + '</span></td>' +
      '<td><code>' + esc(p.KODE_PRESENSI) + '</code></td>' +
      '<td><span class="badge ' + (hadir ? 'hadir' : 'belum') + '">' + p.STATUS_HADIR + '</span></td>' +
      '<td>' + (hadir ? esc(p.DICATAT_OLEH || '-') : '<span style="color:#9ca3af;">-</span>') + '</td>' +
      '<td><span class="badge ' + (terkirim ? 'terkirim' : 'belum-kirim') + '">' + (terkirim ? 'Sudah Terkirim' : 'Belum Terkirim') + '</span></td>' +
      '<td class="row">' +
        '<button class="' + emailBtnClass + '" onclick="kirimSatuEmail(\'' + p.ID_PESERTA + '\')">' + emailBtnLabel + '</button>' +
        '<button class="btn danger sm" onclick="removeParticipant(\'' + p.ID_PESERTA + '\')">Hapus</button>' +
      '</td></tr>';
  }).join('');
}

function openParticipantModal() {
  if (!currentEventId) { showResultModal('warn', 'Pilih event dulu', 'Pilih event di atas sebelum menambah peserta.'); return; }
  document.getElementById('peserta-nama').value = '';
  document.getElementById('peserta-email').value = '';
  openModal('modal-peserta');
}

function saveParticipant() {
  const data = { nama: document.getElementById('peserta-nama').value.trim(), email: document.getElementById('peserta-email').value.trim() };
  if (!data.nama) { showResultModal('warn', 'Belum lengkap', 'Nama peserta wajib diisi.'); return; }
  gsRun('addParticipant', [currentEventId, data], 'Menyimpan peserta...')
    .then(function () { closeModal('modal-peserta'); showSuccess('Peserta berhasil ditambahkan.'); loadPeserta(); })
    .catch(showErrorModal);
}

function removeParticipant(id) {
  showConfirm('Hapus peserta ini?', 'Hapus Peserta').then(function (ok) {
    if (!ok) return;
    gsRun('deleteParticipant', [id], 'Menghapus peserta...')
      .then(function () { showSuccess('Peserta berhasil dihapus.'); loadPeserta(); })
      .catch(showErrorModal);
  });
}

function hapusSemuaPeserta() {
  const scopedToOneEvent = !!currentEventId;
  const namaEvent = scopedToOneEvent ? eventNameById_(currentEventId) : null;
  const pesan = scopedToOneEvent
    ? 'Semua peserta pada event "' + namaEvent + '" akan dihapus permanen (peserta di event lain tidak terpengaruh). Aksi ini tidak bisa dibatalkan.'
    : 'Dropdown sedang di posisi "— Semua Event —", jadi SEMUA peserta dari SEMUA event akan dihapus permanen sekaligus. Aksi ini tidak bisa dibatalkan.';
  showDangerConfirm(pesan, 'Hapus Semua Peserta', 'HAPUS SEMUA PESERTA').then(function (ok) {
    if (!ok) return;
    gsRun('deleteAllParticipants', [currentEventId || ''], 'Menghapus semua peserta...')
      .then(function () { showSuccess('Semua peserta berhasil dihapus.'); loadPeserta(); loadDashboard(); })
      .catch(showErrorModal);
  });
}

function openImportModal() {
  if (!currentEventId) { showResultModal('warn', 'Pilih event dulu', 'Pilih event di atas sebelum import peserta.'); return; }
  document.getElementById('import-text').value = '';
  document.getElementById('import-file').value = '';
  openModal('modal-import');
}

function handleCsvFile(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    const lines = parseCsv_(String(e.target.result));
    if (!lines.length) { showResultModal('warn', 'File kosong', 'File CSV tidak berisi data.'); return; }
    let start = 0;
    if (lines[0][0] && String(lines[0][0]).trim().toLowerCase() === 'nama') start = 1;
    const text = lines.slice(start)
      .filter(function (r) { return r[0] && r[0].trim(); })
      .map(function (r) { return (r[0] || '').trim() + ', ' + (r[1] || '').trim(); })
      .join('\n');
    document.getElementById('import-text').value = text;
    showResultModal('success', 'File terbaca', lines.length - start + ' baris siap diimport. Klik "Import" untuk lanjut.', 2200);
  };
  reader.onerror = function () { showResultModal('error', 'Gagal membaca file', 'Tidak bisa membaca file CSV ini.'); };
  reader.readAsText(file, 'UTF-8');
}

function parseCsv_(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.split('\n').filter(function (l) { return l.trim() !== ''; }).map(function (line) {
    const out = []; let cur = ''; let inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQuotes = false; }
        else { cur += ch; }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  });
}

function submitImport() {
  const raw = document.getElementById('import-text').value.trim();
  if (!raw) { showResultModal('warn', 'Belum ada data', 'Tempel data atau upload file CSV terlebih dahulu.'); return; }
  const list = raw.split('\n').map(function (line) {
    const parts = line.split(',');
    return { nama: (parts[0] || '').trim(), email: (parts[1] || '').trim() };
  }).filter(function (x) { return x.nama; });

  gsRun('addParticipantsBulk', [currentEventId, list], 'Mengimpor peserta...')
    .then(function (result) {
      closeModal('modal-import');
      showSuccess((result || []).length + ' peserta berhasil diimport.');
      loadPeserta();
    }).catch(showErrorModal);
}

function kirimSatuEmail(idPeserta) {
  gsRun('sendKodeEmail', [idPeserta], 'Mengirim email...')
    .then(function () { showSuccess('Email kode presensi berhasil dikirim.'); loadPeserta(); })
    .catch(showErrorModal);
}

function kirimSemuaEmail() {
  if (!currentEventId) { showResultModal('warn', 'Pilih event dulu', 'Pilih event di atas terlebih dahulu.'); return; }
  showConfirm('Kirim kode presensi ke semua peserta yang belum menerima email?', 'Kirim Semua Kode').then(function (ok) {
    if (!ok) return;
    gsRun('sendAllPendingEmails', [currentEventId], 'Mengirim email massal, mohon tunggu...')
      .then(function (r) {
        const tipe = r.gagal ? 'warn' : 'success';
        showResultModal(tipe, r.gagal ? 'Sebagian gagal' : 'Berhasil', 'Sukses: ' + r.sukses + ', Gagal: ' + r.gagal, r.gagal ? 0 : 1800);
        loadPeserta();
      }).catch(showErrorModal);
  });
}

// ---------- PRESENSI ----------
let presensiEventsCache = [];
function loadPresensiEventOptions() {
  gsRun('getAllEvents', [], 'Memuat event...').then(function (list) {
    presensiEventsCache = list || [];
    const sel = document.getElementById('presensi-event-select');
    sel.innerHTML = presensiEventsCache.map(function (e) { return '<option value="' + e.ID_EVENT + '">' + esc(e.NAMA_EVENT) + ' (' + fmtDate(e.TANGGAL) + ')</option>'; }).join('');
    scanEventId = presensiEventsCache.length ? presensiEventsCache[0].ID_EVENT : null;
    updatePresensiBanner_();
    loadPresensiRecap();
  }).catch(showErrorModal);
}

function onPresensiEventChange() {
  scanEventId = document.getElementById('presensi-event-select').value;
  updatePresensiBanner_();
  loadPresensiRecap();
  const cariInput = document.getElementById('input-cari-nama');
  const cariHasil = document.getElementById('cari-nama-hasil');
  if (cariInput) cariInput.value = '';
  if (cariHasil) cariHasil.innerHTML = '';
}

function updatePresensiBanner_() {
  const banner = document.getElementById('presensi-event-banner');
  const e = scanEventId ? presensiEventsCache.find(function (x) { return x.ID_EVENT === scanEventId; }) : null;
  if (!e) { banner.classList.remove('show'); return; }
  document.getElementById('presensi-eb-name').textContent = e.NAMA_EVENT;
  const meta = [fmtDate(e.TANGGAL)];
  if (e.JAM_MULAI) meta.push(e.JAM_MULAI + (e.JAM_SELESAI ? '–' + e.JAM_SELESAI : ''));
  if (e.LOKASI) meta.push(e.LOKASI);
  document.getElementById('presensi-eb-meta').textContent = meta.join('  •  ');
  document.getElementById('presensi-eb-badge').textContent = e.STATUS || '';
  banner.classList.add('show');
}

function loadPresensiRecap() {
  const statsEl = document.getElementById('presensi-recap-stats');
  const listEl = document.getElementById('presensi-recent-list');
  if (!scanEventId) {
    statsEl.innerHTML = '';
    listEl.innerHTML = '<p class="empty">Belum ada event.</p>';
    return;
  }
  gsRun('getRecap', [scanEventId]).then(function (r) {
    r = r || { total: 0, hadir: 0, belum: 0, peserta: [] };
    statsEl.innerHTML =
      statCard(r.hadir, 'Sudah Hadir') +
      statCard(r.belum, 'Belum Hadir') +
      statCard(r.total, 'Total Undangan');

    const recent = (r.peserta || [])
      .filter(function (p) { return p.STATUS_HADIR === 'Hadir' && p.WAKTU_HADIR; })
      .sort(function (a, b) { return new Date(b.WAKTU_HADIR) - new Date(a.WAKTU_HADIR); })
      .slice(0, 8);

    if (!recent.length) {
      listEl.innerHTML = '<p class="empty">Belum ada yang presensi di event ini.</p>';
      return;
    }
    listEl.innerHTML = recent.map(function (p) {
      return '<div class="recent-item">' + avatarChip(p.NAMA, p.EMAIL) +
        (p.DICATAT_OLEH ? '<span class="badge aktif" title="Dicatat oleh">' + esc(p.DICATAT_OLEH) + '</span>' : '') +
        '<span class="recent-time">' + fmtTime(p.WAKTU_HADIR) + '</span></div>';
    }).join('');
  }).catch(showErrorModal);
}

function addOptimisticRecap_(nama, email, petugas) {
  const statsEl = document.getElementById('presensi-recap-stats');
  const nums = statsEl.querySelectorAll('.stat .num');
  if (nums.length >= 2) {
    nums[0].textContent = (parseInt(nums[0].textContent, 10) || 0) + 1;
    nums[1].textContent = Math.max(0, (parseInt(nums[1].textContent, 10) || 0) - 1);
  }
  const listEl = document.getElementById('presensi-recent-list');
  if (listEl.querySelector('.empty')) listEl.innerHTML = '';
  const item = document.createElement('div');
  item.className = 'recent-item';
  item.innerHTML = avatarChip(nama, email) +
    (petugas ? '<span class="badge aktif" title="Dicatat oleh">' + esc(petugas) + '</span>' : '') +
    '<span class="recent-time">' + fmtTime(new Date()) + '</span>';
  listEl.insertBefore(item, listEl.firstChild);
  while (listEl.children.length > 8) listEl.removeChild(listEl.lastChild);
}

// ---------- PRESENSI VIA EMAIL (LINK KLIK) - backup acara online ----------
let linkPresensiEventId_ = null;
let linkPresensiListCache_ = [];

function loadLinkPresensiEventOptions() {
  gsRun('getAllEvents', [], 'Memuat event...').then(function (list) {
    allEventsCache = list || [];
    const sel = document.getElementById('linkpresensi-event-select');
    const current = sel.value;
    sel.innerHTML = allEventsCache.map(function (e) { return '<option value="' + e.ID_EVENT + '">' + esc(e.NAMA_EVENT) + ' (' + fmtDate(e.TANGGAL) + ')</option>'; }).join('');
    if (!allEventsCache.length) {
      linkPresensiEventId_ = null;
      document.getElementById('linkpresensi-table').innerHTML = '';
      document.getElementById('linkpresensi-empty').style.display = 'block';
      return;
    }
    sel.value = current && allEventsCache.some(function (e) { return e.ID_EVENT === current; }) ? current : allEventsCache[0].ID_EVENT;
    loadLinkPresensiList();
  }).catch(showErrorModal);
}

function loadLinkPresensiList() {
  linkPresensiEventId_ = document.getElementById('linkpresensi-event-select').value;
  if (!linkPresensiEventId_) return;
  gsRun('getLinkPresensiList', [linkPresensiEventId_], 'Memuat daftar peserta...').then(function (list) {
    linkPresensiListCache_ = list || [];
    renderLinkPresensiList_(linkPresensiListCache_);
  }).catch(showErrorModal);
}

function renderLinkPresensiList_(list) {
  const emptyEl = document.getElementById('linkpresensi-empty');
  emptyEl.style.display = list.length ? 'none' : 'block';
  document.getElementById('linkpresensi-table').innerHTML = list.map(function (p, i) {
    const hadir = p.statusHadir === 'Hadir';
    const terkirim = p.linkTerkirim;
    const emailBtnLabel = terkirim ? '↻ Kirim Ulang' : '✉ Kirim Email';
    const emailBtnClass = terkirim ? 'btn secondary sm' : 'btn sm';
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + avatarChip(p.nama, p.email) + '</td>' +
      '<td><span class="badge ' + (hadir ? 'hadir' : 'belum') + '">' + esc(p.statusHadir || '-') + (hadir && p.metode ? ' (' + esc(p.metode) + ')' : '') + '</span></td>' +
      '<td><span class="badge ' + (terkirim ? 'terkirim' : 'belum-kirim') + '">' + (terkirim ? 'Sudah Terkirim' : 'Belum Terkirim') + '</span></td>' +
      '<td class="row">' +
        (p.email
          ? '<button class="' + emailBtnClass + '" onclick="kirimSatuLinkPresensi(\'' + p.idPeserta + '\')">' + emailBtnLabel + '</button>'
          : '<span style="color:#9ca3af;font-size:12px;">Tanpa email</span>') +
        '<button class="btn secondary sm" onclick="salinLinkPresensi(' + JSON.stringify(p.url) + ')">📋 Salin Link</button>' +
      '</td></tr>';
  }).join('');
}

function kirimSatuLinkPresensi(idPeserta) {
  gsRun('sendLinkPresensiEmail', [idPeserta], 'Mengirim email...')
    .then(function () { showSuccess('Link presensi berhasil dikirim.'); loadLinkPresensiList(); })
    .catch(showErrorModal);
}

function kirimSemuaLinkPresensi() {
  if (!linkPresensiEventId_) return;
  showConfirm('Kirim link presensi ke semua peserta di event ini yang belum dikirimi?', 'Kirim Semua Link Presensi').then(function (ok) {
    if (!ok) return;
    gsRun('sendAllLinkPresensiEmails', [linkPresensiEventId_], 'Mengirim email ke semua peserta...')
      .then(function (r) {
        showSuccess('Berhasil kirim: ' + r.sukses + '. Gagal: ' + r.gagal + '.');
        loadLinkPresensiList();
      })
      .catch(showErrorModal);
  });
}

function salinLinkPresensi(url) {
  function fallbackCopy() {
    window.prompt('Salin link berikut secara manual:', url);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(function () {
      showSuccess('Link presensi berhasil disalin.');
    }).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

// ---------- LAPORAN ----------
let laporanEntriesCache_ = [];

function loadLaporanEventOptions() {
  gsRun('getAllEvents', [], 'Memuat event...').then(function (list) {
    allEventsCache = list || [];
    const sel = document.getElementById('laporan-event-select');
    const current = sel.value;
    const optSemua = '<option value="">— Semua Event —</option>';
    const optEvents = allEventsCache.map(function (e) { return '<option value="' + e.ID_EVENT + '">' + esc(e.NAMA_EVENT) + ' (' + fmtDate(e.TANGGAL) + ')</option>'; }).join('');
    sel.innerHTML = optSemua + optEvents;
    sel.value = current;
    loadLaporan();
  }).catch(showErrorModal);
}

function loadLaporan() {
  const idEvent = document.getElementById('laporan-event-select').value;
  gsRun('getLogEntries', [idEvent || null], 'Memuat laporan...').then(function (list) {
    laporanEntriesCache_ = list || [];
    populateLaporanPetugasFilter_();
    applyLaporanFilter();
  }).catch(showErrorModal);
}

function populateLaporanPetugasFilter_() {
  const sel = document.getElementById('laporan-petugas-select');
  const current = sel.value;
  const names = Array.from(new Set(laporanEntriesCache_.map(function (r) { return r.olehNama; }).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">— Semua Petugas —</option>' +
    names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
  sel.value = current;
}

function applyLaporanFilter() {
  const petugas = document.getElementById('laporan-petugas-select').value;
  let list = laporanEntriesCache_;
  if (petugas) list = list.filter(function (r) { return r.olehNama === petugas; });
  renderLaporan(list);
}

function renderLaporan(list) {
  const emptyEl = document.getElementById('laporan-empty');
  emptyEl.style.display = list.length ? 'none' : 'block';
  document.getElementById('laporan-table').innerHTML = list.map(function (r, i) {
    const aksiOk = /BERHASIL/.test(r.aksi);
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + fmtDateTime_(r.timestamp) + '</td>' +
      '<td>' + esc(r.nama || '-') + '</td>' +
      '<td>' + (r.namaEvent ? '<span class="badge aktif">' + esc(r.namaEvent) + '</span>' : '-') + '</td>' +
      '<td><span class="badge ' + (aksiOk ? 'hadir' : 'belum') + '">' + esc(r.aksi || '-') + '</span></td>' +
      '<td>' + esc(r.metode || '-') + '</td>' +
      '<td>' + esc(r.olehNama || '-') + '</td>' +
      '</tr>';
  }).join('');
}

function fmtDateTime_(v) {
  if (!v) return '-';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return fmtDate(d) + ' ' + fmtTime(d);
}

function setMode(mode) {
  currentMode = mode;
  document.getElementById('btn-mode-ketik').className = 'btn' + (mode === 'ketik' ? '' : ' secondary');
  document.getElementById('btn-mode-scan').className = 'btn' + (mode === 'scan' ? '' : ' secondary');
  document.getElementById('btn-mode-cari').className = 'btn' + (mode === 'cari' ? '' : ' secondary');
  document.getElementById('panel-ketik').style.display = mode === 'ketik' ? 'block' : 'none';
  document.getElementById('panel-scan').style.display = mode === 'scan' ? 'block' : 'none';
  document.getElementById('panel-cari').style.display = mode === 'cari' ? 'block' : 'none';
  if (mode === 'scan') { startScanner(); }
  else { stopScanner(); }
  if (mode === 'ketik') { focusScannerInput_(); }
}

function focusScannerInput_() {
  const el = document.getElementById('input-scanner');
  if (el) setTimeout(function () { el.focus(); }, 50);
}

const KODE_LENGTH = 6;

function onScannerInput() {
  const el = document.getElementById('input-scanner');
  const val = el.value.trim();
  if (val.length >= KODE_LENGTH) {
    el.value = '';
    processCheckIn(val, 'Scan QR');
  }
}
function onScannerKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const el = document.getElementById('input-scanner');
    const val = el.value.trim();
    el.value = '';
    if (val) processCheckIn(val, 'Scan QR');
  }
}

function submitKetik() {
  const kode = document.getElementById('input-kode').value.trim();
  if (!kode) return;
  document.getElementById('input-kode').value = '';
  processCheckIn(kode, 'Input Manual');
}

// Mode Scan (kamera) — di versi Apps Script dulu ini SELALU gagal ("Kamera
// gagal diakses / Permissions policy violation") karena Apps Script Web App
// membungkus halamannya dalam iframe yang tidak diizinkan Google mengakses
// kamera sama sekali. Di Vercel halaman ini berdiri sendiri (bukan iframe),
// jadi getUserMedia() seharusnya berfungsi normal seperti situs web biasa.
function startScanner() {
  if (html5QrCode) return;
  html5QrCode = new Html5Qrcode('qr-reader');
  Html5Qrcode.getCameras().then(function (cams) {
    if (!cams || !cams.length) { showResultModal('error', 'Kamera tidak ditemukan', 'Pastikan izin kamera sudah diberikan ke browser ini.'); return; }
    renderCameraSelect_(cams);
    const sel = document.getElementById('camera-select');
    const cameraId = (sel && sel.value) ? sel.value : cams[cams.length - 1].id;
    launchCamera_(cameraId);
  }).catch(function () { showResultModal('error', 'Kamera gagal diakses', 'Tidak bisa mengakses kamera perangkat ini.'); });
}

function renderCameraSelect_(cams) {
  const wrap = document.getElementById('camera-select-wrap');
  if (!wrap) return;
  if (cams.length <= 1) { wrap.style.display = 'none'; return; }
  const sel = document.getElementById('camera-select');
  sel.innerHTML = cams.map(function (c, i) { return '<option value="' + c.id + '">' + esc(c.label || ('Kamera ' + (i + 1))) + '</option>'; }).join('');
  sel.value = cams[cams.length - 1].id;
  wrap.style.display = 'block';
}

function onCameraChange() {
  const sel = document.getElementById('camera-select');
  if (!sel.value) return;
  stopScanner(function () {
    html5QrCode = new Html5Qrcode('qr-reader');
    launchCamera_(sel.value);
  });
}

function launchCamera_(cameraId) {
  html5QrCode.start(
    cameraId,
    { fps: 10, qrbox: 240 },
    function (decodedText) {
      processCheckIn(decodedText, 'Scan QR');
    }
  ).catch(function () { showResultModal('error', 'Kamera gagal diakses', 'Tidak bisa memulai kamera yang dipilih. Coba pilih kamera lain di dropdown.'); });
}

function stopScanner(cb) {
  if (html5QrCode) {
    html5QrCode.stop().then(function () { html5QrCode.clear(); html5QrCode = null; if (cb) cb(); })
      .catch(function () { html5QrCode = null; if (cb) cb(); });
  } else if (cb) { cb(); }
}

let processing = false;
let lastScanCode_ = '';
let lastScanTime_ = 0;
const SCAN_DUPLICATE_WINDOW_MS = 4000;

function processCheckIn(kode, metode) {
  if (processing) return;
  const normalized = String(kode || '').trim().toUpperCase();
  if (!normalized) return;

  const now = Date.now();
  if (normalized === lastScanCode_ && (now - lastScanTime_) < SCAN_DUPLICATE_WINDOW_MS) {
    // Sengaja TIDAK menampilkan modal untuk kasus ini (cukup kotak kecil) —
    // ini bisa terpicu berkali-kali sangat cepat karena kamera terus
    // mendeteksi QR yang sama selama beberapa frame berturut-turut sebelum
    // operator sempat menjauhkan kamera; modal yang muncul-hilang berkali-
    // kali dalam hitungan detik akan lebih mengganggu daripada membantu.
    renderPresensiResult({
      ok: false,
      duplicateScan: true,
      message: 'Kode "' + normalized + '" baru saja diproses beberapa detik lalu. Mohon tunggu sebentar sebelum scan ulang.'
    });
    focusScannerInput_();
    return;
  }
  lastScanCode_ = normalized;
  lastScanTime_ = now;

  processing = true;
  gsRun('checkIn', [normalized, metode, scanEventId], 'Memproses presensi...')
    .then(function (res) {
      processing = false;
      renderPresensiResult(res);
      showScanResultModal_(res);
      if (res.ok) {
        addOptimisticRecap_(res.nama, res.email, res.petugas);
        // Fire-and-forget: tidak menunggu hasilnya, supaya operator bisa
        // langsung lanjut scan berikutnya tanpa menunggu email terkirim dulu.
        if (res.idPeserta) { callGas('kirimKonfirmasiHadirAsync', [res.idPeserta]).catch(function () {}); }
      }
      focusScannerInput_();
    })
    .catch(function (err) {
      processing = false;
      const res = { ok: false, message: err.message || String(err) };
      renderPresensiResult(res);
      showScanResultModal_(res);
      focusScannerInput_();
    });
}

// ---------- CARI NAMA (fallback: tamu lupa email / tidak tahu kode presensi) ----------
let cariNamaTimer_ = null;
let cariNamaSeq_ = 0;

function onCariNamaInput() {
  const kw = document.getElementById('input-cari-nama').value.trim();
  clearTimeout(cariNamaTimer_);
  const hasilEl = document.getElementById('cari-nama-hasil');
  if (kw.length < 2) { hasilEl.innerHTML = ''; return; }
  hasilEl.innerHTML = '<p class="empty">Mencari...</p>';
  cariNamaTimer_ = setTimeout(function () { runCariNama_(kw); }, 300);
}

function runCariNama_(kw) {
  if (!scanEventId) { document.getElementById('cari-nama-hasil').innerHTML = '<p class="empty">Pilih event dulu.</p>'; return; }
  const seq = ++cariNamaSeq_;
  callGas('searchParticipantsForCheckIn', [scanEventId, kw]).then(function (list) {
    if (seq !== cariNamaSeq_) return;
    renderCariNamaHasil_(list || []);
  }).catch(function (err) {
    if (seq !== cariNamaSeq_) return;
    document.getElementById('cari-nama-hasil').innerHTML = '<p class="empty">Gagal mencari: ' + esc(err.message || String(err)) + '</p>';
  });
}

function renderCariNamaHasil_(list) {
  const hasilEl = document.getElementById('cari-nama-hasil');
  if (!list.length) { hasilEl.innerHTML = '<p class="empty">Tidak ada nama yang cocok di event ini.</p>'; return; }
  hasilEl.innerHTML = list.map(function (p) {
    const sudahHadir = p.statusHadir === 'Hadir';
    return '<div class="recent-item">' + avatarChip(p.nama, p.email) +
      (sudahHadir
        ? '<span class="badge terkirim">Sudah Hadir</span>'
        : '<button class="btn sm" onclick="submitCariNama(\'' + p.idPeserta + '\', ' + JSON.stringify(p.nama) + ')">Presensi</button>') +
      '</div>';
  }).join('');
}

function submitCariNama(idPeserta, nama) {
  if (processing) return;
  showConfirm('Catat presensi untuk "' + nama + '"?', 'Konfirmasi Presensi').then(function (ok) {
    if (!ok) return;
    processing = true;
    gsRun('checkInById', [idPeserta, 'Cari Nama', scanEventId], 'Memproses presensi...')
      .then(function (res) {
        processing = false;
        renderPresensiResult(res);
        if (res.ok) {
          addOptimisticRecap_(res.nama, res.email, res.petugas);
          if (res.idPeserta) { callGas('kirimKonfirmasiHadirAsync', [res.idPeserta]).catch(function () {}); }
          document.getElementById('input-cari-nama').value = '';
          document.getElementById('cari-nama-hasil').innerHTML = '';
        } else {
          const kw = document.getElementById('input-cari-nama').value.trim();
          if (kw.length >= 2) runCariNama_(kw);
        }
      })
      .catch(function (err) { processing = false; renderPresensiResult({ ok: false, message: err.message || String(err) }); });
  });
}

function renderPresensiResult(res) {
  const cls = res.ok ? 'ok' : ((res.sudahHadir || res.eventMismatch || res.duplicateScan || res.outsideWindow) ? 'warn' : 'err');
  let html = '<div class="result-box ' + cls + '">';
  if (res.ok) {
    html += '<strong>✅ ' + esc(res.nama) + '</strong>' +
      (res.namaEvent ? ' <span class="badge aktif">' + esc(res.namaEvent) + '</span>' : '') +
      '<br>Presensi tercatat.';
  } else if (res.duplicateScan) {
    html += '<strong>⏱️ Tunggu Sebentar</strong><br>' + esc(res.message);
  } else if (res.outsideWindow) {
    html += '<strong>🕒 Belum/Sudah Waktunya</strong>' +
      (res.namaEvent ? ' <span class="badge aktif">' + esc(res.namaEvent) + '</span>' : '') +
      '<br>' + esc(res.message);
  } else if (res.eventMismatch) {
    html += '<strong>⚠️ Event tidak sesuai</strong>' +
      (res.namaEvent ? ' <span class="badge aktif">' + esc(res.namaEvent) + '</span>' : '') +
      '<br>' + esc(res.message);
  } else if (res.sudahHadir) {
    html += '<strong>⚠️ ' + esc(res.nama) + '</strong><br>Sudah presensi sebelumnya.';
  } else {
    html += '<strong>❌ Gagal</strong><br>' + esc(res.message);
  }
  html += '</div>';
  document.getElementById('presensi-result').innerHTML = html;
}

// ---------- ADMIN ----------
function loadAdmins() {
  gsRun('getAllAdmins', [], 'Memuat admin...').then(function (list) {
    list = list || [];
    document.getElementById('admin-table').innerHTML = list.map(function (a, i) {
      const aktif = String(a.AKTIF).toLowerCase() === 'ya';
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(a.EMAIL) + '</td><td>' + esc(a.NAMA) + '</td>' +
        '<td><span class="badge ' + (aktif ? 'terkirim' : 'belum-kirim') + '">' + (aktif ? 'Aktif' : 'Nonaktif') + '</span></td>' +
        '<td>' + (aktif ? '<button class="btn danger sm" onclick="nonaktifkanAdmin(\'' + a.EMAIL + '\')">Nonaktifkan</button>' : '') + '</td></tr>';
    }).join('');
  }).catch(showErrorModal);
}

function openAdminModal() {
  document.getElementById('admin-email').value = '';
  document.getElementById('admin-nama').value = '';
  document.getElementById('admin-role').value = 'Admin';
  openModal('modal-admin');
}

function saveAdmin() {
  const email = document.getElementById('admin-email').value.trim();
  const nama = document.getElementById('admin-nama').value.trim();
  const role = document.getElementById('admin-role').value;
  if (!email) { showResultModal('warn', 'Belum lengkap', 'Email wajib diisi.'); return; }
  gsRun('addAdmin', [email, nama, role], 'Menyimpan admin...')
    .then(function () { closeModal('modal-admin'); showSuccess('Admin berhasil ditambahkan.'); loadAdmins(); })
    .catch(showErrorModal);
}

function nonaktifkanAdmin(email) {
  showConfirm('Nonaktifkan admin ' + email + '?', 'Nonaktifkan Admin').then(function (ok) {
    if (!ok) return;
    gsRun('removeAdmin', [email], 'Menonaktifkan admin...')
      .then(function () { showSuccess('Admin berhasil dinonaktifkan.'); loadAdmins(); })
      .catch(showErrorModal);
  });
}

// ---------- UTIL ----------
function esc(s) { return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
function toDateInput(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.toISOString().slice(0, 10);
}
function badgeStatus(s) {
  const map = { 'Aktif': 'aktif', 'Selesai': 'selesai', 'Nonaktif': 'belum' };
  return '<span class="badge ' + (map[s] || 'belum') + '">' + esc(s) + '</span>';
}

const AVATAR_PALETTE = [
  { bg: '#ffe1c4', fg: '#9a4d05' },
  { bg: '#cdf3dd', fg: '#0f6b3f' },
  { bg: '#e3daff', fg: '#513a99' },
  { bg: '#ffd6e3', fg: '#a3184f' },
  { bg: '#d3ecff', fg: '#155b96' }
];
function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  const first = parts[0] ? parts[0][0] : '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}
function avatarChip(name, sub) {
  let hash = 0;
  for (var i = 0; i < (name || '').length; i++) hash = (hash + name.charCodeAt(i)) % AVATAR_PALETTE.length;
  const c = AVATAR_PALETTE[hash];
  return '<div class="who">' +
    '<div class="avatar" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(initials(name)) + '</div>' +
    '<div class="who-text"><div class="who-name">' + esc(name || '-') + '</div>' +
    (sub ? '<div class="who-sub">' + esc(sub) + '</div>' : '') + '</div></div>';
}

// ---------- INIT ----------
// Beda dari versi Apps Script (yang langsung loadDashboard() karena login sudah
// pasti terjadi lewat Google Workspace sebelum halaman ini ter-render sama
// sekali): di sini harus tunggu proses login Google (GIS) dulu, baru masuk app.
document.addEventListener('DOMContentLoaded', function () {
  initGoogleSignIn_();
  if (idToken_) {
    verifySessionAndEnter_();
  }
});
