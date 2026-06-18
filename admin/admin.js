/* ── CSRF token interceptor (auto-attach X-CSRF-Token to every mutating fetch) ── */
let _csrfToken = '';
let _adminRole = 'viewer';
let _adminUsername = '';
let _lastLogin = '';

(async () => {
  try {
    const d = await fetch('/api/auth/csrf').then(r => r.json());
    _csrfToken = d.token || '';
  } catch {}
})();

const _origFetch = window.fetch.bind(window);
window.fetch = function(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    opts.headers = Object.assign({}, opts.headers, { 'X-CSRF-Token': _csrfToken });
  }
  return _origFetch(url, opts);
};

/* ── Load user info & apply RBAC ── */
async function loadUserInfo() {
  try {
    const me = await _origFetch('/api/auth/me').then(r => r.json());
    if (!me.loggedIn) { window.location.href = '/admin/login'; return; }
    _adminRole     = me.role     || 'viewer';
    _adminUsername = me.username || 'admin';
    _lastLogin     = me.lastLogin || '';

    // Update sidebar footer
    const userEl = document.querySelector('.sb-footer-user');
    if (userEl) userEl.textContent = _adminUsername;

    if (_lastLogin) {
      const d = new Date(_lastLogin);
      const el = document.getElementById('lastLoginInfo');
      if (el) el.textContent = 'Last login: ' + d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
    }

    // RBAC: hide Payments nav and section for non-super_admin roles
    if (_adminRole !== 'super_admin') {
      document.querySelectorAll('[data-section="payments"]').forEach(el => el.style.display = 'none');
    }
    // RBAC: disable delete/edit actions for viewer role
    if (_adminRole === 'viewer') {
      document.querySelectorAll('.btn-delete, .btn-edit, [data-action="save"], [data-action="delete"]').forEach(el => {
        el.disabled = true;
        el.title = 'Read-only access';
      });
    }
    // Show 2FA status and toggle buttons
    const totpBadge  = document.getElementById('totp-status-badge');
    const enableBtn  = document.getElementById('totp-enable-btn');
    const disableBtn = document.getElementById('totp-disable-btn');
    if (totpBadge) {
      totpBadge.textContent = me.totpEnabled ? '✓ Enabled' : 'Disabled';
      totpBadge.style.color = me.totpEnabled ? 'var(--green)' : 'var(--amber)';
    }
    if (enableBtn)  enableBtn.style.display  = me.totpEnabled ? 'none' : '';
    if (disableBtn) disableBtn.style.display = me.totpEnabled ? '' : 'none';
  } catch {}
}

/* ── Nav ── */
let currentSection = 'dashboard';
let currentBookingId = null;
let allPackages = [];

function navigate(sec) {
  // Restore sidebar/topbar if leaving full preview mode
  if (sec !== 'preview' && previewFull) {
    previewFull = false;
    document.getElementById('sidebar').style.display = '';
    document.querySelector('.top-bar').style.display = '';
    const fpb = document.getElementById('fullPreviewBtn');
    if (fpb) {
      fpb.classList.remove('fullactive');
      document.getElementById('fullPreviewIconExpand').style.display = '';
      document.getElementById('fullPreviewIconContract').style.display = 'none';
      document.getElementById('fullPreviewBtnText').textContent = 'Full Preview';
    }
  }
  document.querySelectorAll('.sb-item').forEach(i => i.classList.toggle('active', i.dataset.section === sec));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === `sec-${sec}`));
  const titles = { dashboard:'Dashboard', bookings:'Bookings', contacts:'Messages', packages:'Packages & Pricing', gallery:'Media Manager', payments:'Payments', privacy:'Data & Privacy (GDPR)', settings:'Settings', builder:'Site Builder', preview:'Live Preview' };
  document.getElementById('topBarTitle').textContent = titles[sec] || sec;
  document.getElementById('main').classList.toggle('preview-active', sec === 'preview');
  currentSection = sec;
  if (sec === 'dashboard') loadDashboard();
  if (sec === 'bookings')  loadBookings();
  if (sec === 'contacts')  loadContacts();
  if (sec === 'packages')  loadPackages();
  if (sec === 'gallery')   loadMedia();
  if (sec === 'payments')  loadPayments();
  if (sec === 'settings')  loadSettings();
  if (sec === 'privacy')   loadPrivacy();
  if (sec === 'builder')   loadBuilder();
  if (sec === 'preview')   initPreview();
}

document.querySelectorAll('.sb-item').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.section));
});

/* ── Auth ── */
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/admin/login';
}

/* ── Toast ── */
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = (type === 'success' ? '✓  ' : '✕  ') + msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Dashboard ── */
async function loadDashboard() {
  const data = await fetch('/api/dashboard').then(r => r.json());
  document.getElementById('dc-month').textContent     = data.totalThisMonth;
  document.getElementById('dc-pending').textContent   = data.pending;
  document.getElementById('dc-confirmed').textContent = data.confirmed;
  document.getElementById('dc-popular').textContent   = data.popularPackage;
  if (data.pending > 0) {
    const badge = document.getElementById('pendingBadge');
    badge.textContent = data.pending;
    badge.style.display = '';
  }
  const tbody = document.getElementById('recentBody');
  if (!data.recentBookings.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No bookings yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.recentBookings.map(b => `
    <tr>
      <td class="td-name">${esc(b.name)}</td>
      <td>${tierBadge(b.tier)}</td>
      <td>${b.frequency ? b.frequency + '/mo' : '—'}</td>
      <td>${b.preferred_date ? b.preferred_date.slice(0,10) : fmtDate(b.created_at)}</td>
      <td>${statusBadge(b.status)}</td>
    </tr>`).join('');
}

/* ── Bookings ── */
async function loadBookings() {
  const search = document.getElementById('bookSearch')?.value ?? '';
  const status = document.getElementById('bookStatus')?.value ?? 'all';
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status !== 'all') params.set('status', status);
  const data = await fetch('/api/bookings?' + params).then(r => r.json());
  const tbody = document.getElementById('bookBody');
  if (!data.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No bookings found</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(b => `
    <tr>
      <td>${b.id}</td>
      <td><div class="td-name">${esc(b.name)}</div><div style="font-size:.72rem;color:var(--muted)">${esc(b.email)}</div></td>
      <td>${esc(b.vehicle_make)} ${esc(b.vehicle_model)}</td>
      <td>${tierBadge(b.tier)}</td>
      <td>${b.frequency ? b.frequency + '/mo' : '—'}</td>
      <td style="max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${b.addons.join(', ') || '—'}</td>
      <td>${b.preferred_date ? b.preferred_date.slice(0,10) : fmtDate(b.created_at)}</td>
      <td>${statusBadge(b.status)}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="openBookingModal(${JSON.stringify(b).replace(/"/g,'&quot;')})">Edit</button></td>
    </tr>`).join('');
}

function openBookingModal(b) {
  currentBookingId = b.id;
  document.getElementById('modalId').textContent    = b.id;
  document.getElementById('modalName').value        = b.name;
  document.getElementById('modalEmail').value       = b.email;
  document.getElementById('modalStatus').value      = b.status;
  document.getElementById('modalNotes').value       = b.notes || '';
  document.getElementById('bookModal').classList.add('open');
}
function closeModal() { document.getElementById('bookModal').classList.remove('open'); }
document.getElementById('bookModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

async function saveBooking() {
  const res = await fetch(`/api/bookings/${currentBookingId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: document.getElementById('modalStatus').value,
      notes:  document.getElementById('modalNotes').value,
    }),
  });
  if (res.ok) { closeModal(); loadBookings(); if (currentSection === 'dashboard') loadDashboard(); toast('Booking updated'); }
  else toast('Failed to save', 'error');
}

async function deleteBooking() {
  if (!confirm('Delete this booking permanently?')) return;
  const res = await fetch(`/api/bookings/${currentBookingId}`, { method: 'DELETE' });
  if (res.ok) { closeModal(); loadBookings(); toast('Booking deleted'); }
  else toast('Failed to delete', 'error');
}

/* ── Contacts ── */
async function loadContacts() {
  const data = await fetch('/api/contacts').then(r => r.json());
  const tbody = document.getElementById('contactBody');
  if (!data.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No messages yet</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(c => `
    <tr>
      <td>${c.id}</td>
      <td class="td-name">${esc(c.name)}</td>
      <td>${esc(c.email)}</td>
      <td>${esc(c.phone) || '—'}</td>
      <td style="max-width:280px">${esc(c.message)}</td>
      <td>${fmtDate(c.created_at)}</td>
      <td><button class="btn btn-danger btn-xs" onclick="deleteContact(${c.id})">Delete</button></td>
    </tr>`).join('');
}

async function deleteContact(id) {
  if (!confirm('Delete this message?')) return;
  const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
  if (res.ok) { loadContacts(); toast('Message deleted'); }
}

/* ── Packages ── */
async function loadPackages() {
  const grid = document.getElementById('pkgGrid');
  grid.innerHTML = '<p style="color:var(--muted);font-size:.83rem">Loading packages…</p>';
  try {
    const [pkgRes, settingsRes] = await Promise.all([
      fetch('/api/packages'),
      fetch('/api/settings'),
    ]);
    if (!pkgRes.ok) throw new Error(`Server error ${pkgRes.status}`);
    allPackages = await pkgRes.json();
    const s = settingsRes.ok ? await settingsRes.json() : {};
    document.getElementById('pkg-name-bronze').value = s.tier_bronze_name || 'BRONZE';
    document.getElementById('pkg-name-silver').value = s.tier_silver_name || 'SILVER';
    document.getElementById('pkg-name-gold').value   = s.tier_gold_name   || 'GOLD';
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--red);font-size:.83rem">Failed to load packages: ${err.message}. Please refresh.</p>`;
    return;
  }
  const tierInfo = {
    bronze: { label:'Bronze', cls:'pkg-tier-bronze', emoji:'🥉' },
    silver: { label:'Silver', cls:'pkg-tier-silver', emoji:'🥈' },
    gold:   { label:'Gold',   cls:'pkg-tier-gold',   emoji:'🥇' },
  };
  grid.innerHTML = allPackages.map(p => {
    const t = tierInfo[p.tier] || {};
    const freqLabel = p.freq === 1 ? 'Wash Once' : `${p.freq} / month`;
    const featuresText = (p.features || []).join('\n');
    return `<div class="pkg-card ${t.cls}">
      <div class="pkg-card-header">
        <div class="pkg-tier-dot"></div>
        <div class="pkg-tier-label">${t.emoji} ${t.label}</div>
        <div class="pkg-freq-label">${freqLabel}</div>
      </div>
      <div class="pkg-price-row">
        <span class="currency">£</span>
        <input class="pkg-price-input" type="number" min="0" max="9999" value="${p.price}" data-tier="${p.tier}" data-freq="${p.freq}" data-field="price" />
        <span class="per">${p.freq === 1 ? 'one-time' : '/mo'}</span>
      </div>
      <label class="vis-toggle">
        <input type="checkbox" ${p.visible ? 'checked' : ''} data-tier="${p.tier}" data-freq="${p.freq}" data-field="visible" /> Visible on site
      </label>
      <div class="pkg-features-label">Features (one per line)</div>
      <textarea class="pkg-features-textarea" rows="5" data-tier="${p.tier}" data-freq="${p.freq}" data-field="features">${esc(featuresText)}</textarea>
    </div>`;
  }).join('');
}

async function savePackages() {
  if (!allPackages.length) { toast('No packages loaded — please refresh the page', 'error'); return; }
  const btn = document.querySelector('#sec-packages .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const updated = allPackages.map(p => {
    const price   = document.querySelector(`input[data-tier="${p.tier}"][data-freq="${p.freq}"][data-field="price"]`);
    const vis     = document.querySelector(`input[data-tier="${p.tier}"][data-freq="${p.freq}"][data-field="visible"]`);
    const featTa  = document.querySelector(`textarea[data-tier="${p.tier}"][data-freq="${p.freq}"][data-field="features"]`);
    return {
      tier: p.tier, freq: p.freq,
      price: parseInt(price?.value) || p.price,
      visible: vis?.checked ? 1 : 0,
      features: featTa?.value.split('\n').map(s => s.trim()).filter(Boolean) || p.features,
    };
  });
  const tierNames = {
    tier_bronze_name: document.getElementById('pkg-name-bronze').value.trim() || 'BRONZE',
    tier_silver_name: document.getElementById('pkg-name-silver').value.trim() || 'SILVER',
    tier_gold_name:   document.getElementById('pkg-name-gold').value.trim()   || 'GOLD',
  };
  try {
    const [res] = await Promise.all([
      fetch('/api/packages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      }),
      fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tierNames),
      }),
    ]);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      toast('Packages saved — live site updated');
    } else if (res.status === 401) {
      toast('Session expired — please log in again', 'error');
      setTimeout(() => { window.location.href = '/admin/login'; }, 1500);
    } else if (res.status === 403) {
      toast(data.error === 'Insufficient permissions' ? 'Your account does not have permission to edit packages' : 'Security check failed — please refresh the page', 'error');
    } else {
      toast(data.error || 'Save failed — please try again', 'error');
    }
  } catch (err) {
    toast('Network error — check your connection', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save All Packages'; }
  }
}

/* ── Media ── */
let selectedFile = null;

function toggleUrlField() {
  const type = document.getElementById('mediaType').value;
  document.getElementById('urlFieldWrap').style.display = type === 'video' ? '' : 'none';
}
toggleUrlField();

function onFileSelect(e) {
  selectedFile = e.target.files[0];
  if (!selectedFile) return;
  const prev = document.getElementById('filePreview');
  const img  = document.getElementById('filePreviewImg');
  const nm   = document.getElementById('filePreviewName');
  prev.style.display = '';
  nm.textContent = selectedFile.name + ' (' + (selectedFile.size / 1024 / 1024).toFixed(1) + ' MB)';
  if (selectedFile.type.startsWith('image/')) {
    img.src = URL.createObjectURL(selectedFile);
    img.style.display = '';
  } else {
    img.style.display = 'none';
  }
}

async function uploadMedia() {
  const type    = document.getElementById('mediaType').value;
  const label   = document.getElementById('mediaLabel').value.trim();
  const vehicle = document.getElementById('mediaVehicle').value.trim();
  const url     = document.getElementById('mediaUrl').value.trim();
  const caption = document.getElementById('mediaCaption').value.trim();
  const altText = document.getElementById('mediaAltText').value.trim();

  const fd = new FormData();
  fd.append('type', type);
  fd.append('label', label);
  fd.append('vehicle', vehicle);
  fd.append('caption', caption);
  fd.append('alt_text', altText);
  if (selectedFile) fd.append('file', selectedFile);
  else if (url) fd.append('url', url);
  else return toast('Please select a file or enter a URL', 'error');

  const btn = document.querySelector('#sec-gallery .btn.btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  const res = await fetch('/api/media', { method: 'POST', body: fd });
  if (btn) { btn.disabled = false; btn.textContent = 'Upload & Add'; }
  if (res.ok) {
    toast('Media uploaded');
    selectedFile = null;
    document.getElementById('mediaFile').value = '';
    document.getElementById('mediaLabel').value = '';
    document.getElementById('mediaVehicle').value = '';
    document.getElementById('mediaUrl').value = '';
    document.getElementById('mediaCaption').value = '';
    document.getElementById('mediaAltText').value = '';
    document.getElementById('filePreview').style.display = 'none';
    loadMedia();
  } else {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Upload failed', 'error');
  }
}

let _mediaData = [];
let _mediaDragSrc = null;

async function loadMedia() {
  const typeFilter   = document.getElementById('mediaFilterType')?.value || '';
  const searchFilter = (document.getElementById('mediaFilterSearch')?.value || '').toLowerCase();
  const data = await fetch('/api/media').then(r => r.json());
  _mediaData = data;
  const grid = document.getElementById('mediaGrid');

  let filtered = data;
  if (typeFilter) filtered = filtered.filter(m => m.type === typeFilter);
  if (searchFilter) filtered = filtered.filter(m => (m.label || '').toLowerCase().includes(searchFilter));

  if (!filtered.length) {
    grid.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:20px 0">' + (data.length ? 'No results for that filter.' : 'No media uploaded yet. Add photos and videos above.') + '</div>';
    return;
  }

  grid.innerHTML = filtered.map(m => `
    <div class="media-item" draggable="true" data-id="${m.id}" data-order="${m.sort_order}">
      <div class="media-drag-handle" title="Drag to reorder">⠿</div>
      <div class="media-thumb">
        ${m.type === 'photo'
          ? `<img src="${esc(m.url)}" alt="${esc(m.alt_text || m.label)}" />`
          : `<div style="padding:16px;text-align:center"><div style="font-size:1.5rem">▶</div><div style="font-size:.7rem;margin-top:4px;color:var(--muted)">${esc(m.label || 'Video')}</div></div>`}
      </div>
      <div class="media-info">
        <div class="media-label">${esc(m.label || 'Untitled')}</div>
        <div class="media-vehicle">${esc(m.caption || m.vehicle || '—')}</div>
      </div>
      <button class="media-delete" onclick="deleteMedia(${m.id})" title="Delete">&times;</button>
    </div>`).join('');

  // Drag-and-drop reorder
  grid.querySelectorAll('.media-item').forEach(card => {
    card.addEventListener('dragstart', e => {
      _mediaDragSrc = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      saveMediaOrder();
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      if (_mediaDragSrc && _mediaDragSrc !== card) {
        if (after) card.after(_mediaDragSrc);
        else card.before(_mediaDragSrc);
      }
    });
  });
}

async function saveMediaOrder() {
  const cards = document.querySelectorAll('#mediaGrid .media-item');
  const ids = Array.from(cards).map(c => parseInt(c.dataset.id));
  await fetch('/api/media/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => {});
}

async function deleteMedia(id) {
  if (!confirm('Delete this media item?')) return;
  const res = await fetch(`/api/media/${id}`, { method: 'DELETE' });
  if (res.ok) { loadMedia(); toast('Media deleted'); }
  else toast('Delete failed', 'error');
}

/* ── Slides (Hero Slideshow) ── */
let _slides = [];
let _slidesDragSrc = null;

async function loadSlides() {
  const [slides, settings] = await Promise.all([
    fetch('/api/slides/all').then(r => r.json()),
    fetch('/api/settings').then(r => r.json()),
  ]);
  _slides = slides;

  // Populate slideshow settings
  const enEl = document.getElementById('b-slideshow-enabled');
  if (enEl) enEl.checked = settings.slideshow_enabled === '1';
  const trEl = document.getElementById('b-slideshow-transition');
  if (trEl) trEl.value = settings.slideshow_transition || 'fade';
  const ivEl = document.getElementById('b-slideshow-interval');
  if (ivEl) ivEl.value = settings.slideshow_interval || '5';
  const apEl = document.getElementById('b-slideshow-autoplay');
  if (apEl) apEl.checked = settings.slideshow_autoplay !== '0';
  const dtEl = document.getElementById('b-slideshow-dots');
  if (dtEl) dtEl.checked = settings.slideshow_dots !== '0';
  const arEl = document.getElementById('b-slideshow-arrows');
  if (arEl) arEl.checked = settings.slideshow_arrows !== '0';

  renderSlideList(slides);
}

function renderSlideList(slides) {
  const list = document.getElementById('slide-list');
  if (!list) return;
  if (!slides.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:16px 0">No slides yet. Add one above.</div>';
    return;
  }
  list.innerHTML = slides.map((s, i) => `
    <div class="slide-card" draggable="true" data-id="${s.id}" data-idx="${i}">
      <div class="slide-card-drag" title="Drag to reorder">⠿</div>
      <div class="slide-card-thumb">
        ${s.image_url ? `<img src="${esc(s.image_url)}" alt="slide" />` : '<span>No image</span>'}
      </div>
      <div class="slide-card-info">
        <div class="slide-card-title">${esc(s.headline || '(No headline)')}</div>
        <div class="slide-card-sub">${esc(s.sub || '')} ${s.video_url ? '🎥' : ''} ${!s.visible ? '(hidden)' : ''}</div>
      </div>
      <div class="slide-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="editSlide(${s.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSlide(${s.id})">✕</button>
      </div>
    </div>`).join('');

  // Drag-and-drop for slide list
  list.querySelectorAll('.slide-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      _slidesDragSrc = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      saveSlidesOrder();
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      if (_slidesDragSrc && _slidesDragSrc !== card) {
        if (e.clientY > rect.top + rect.height / 2) card.after(_slidesDragSrc);
        else card.before(_slidesDragSrc);
      }
    });
  });
}

async function saveSlidesOrder() {
  const cards = document.querySelectorAll('#slide-list .slide-card');
  const ids = Array.from(cards).map(c => parseInt(c.dataset.id));
  await fetch('/api/slides/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => {});
}

let _slideFileImg = null;
let _slideFileVid = null;

document.getElementById('ns-file')?.addEventListener('change', e => { _slideFileImg = e.target.files[0]; });
document.getElementById('ns-video-file')?.addEventListener('change', e => { _slideFileVid = e.target.files[0]; });

async function addSlide() {
  const fd = new FormData();
  fd.append('headline', document.getElementById('ns-headline').value.trim());
  fd.append('sub', document.getElementById('ns-sub').value.trim());
  fd.append('cta1_text', document.getElementById('ns-cta1-text').value.trim());
  fd.append('cta1_link', document.getElementById('ns-cta1-link').value.trim());
  fd.append('cta2_text', document.getElementById('ns-cta2-text').value.trim());
  fd.append('cta2_link', document.getElementById('ns-cta2-link').value.trim());
  fd.append('overlay_color', document.getElementById('ns-overlay-color').value);
  fd.append('overlay_opacity', document.getElementById('ns-overlay-opacity').value);
  fd.append('sort_order', _slides.length);
  if (_slideFileImg) {
    fd.append('file', _slideFileImg);
  } else {
    fd.append('image_url', document.getElementById('ns-image-url').value.trim());
  }
  if (_slideFileVid) {
    fd.append('file', _slideFileVid);
  } else {
    fd.append('video_url', document.getElementById('ns-video-url').value.trim());
  }
  const res = await fetch('/api/slides', { method: 'POST', body: fd });
  if (res.ok) {
    toast('Slide added');
    _slideFileImg = null; _slideFileVid = null;
    ['ns-headline','ns-sub','ns-cta1-text','ns-cta1-link','ns-cta2-text','ns-cta2-link','ns-image-url','ns-video-url'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('ns-file').value = '';
    document.getElementById('ns-video-file').value = '';
    loadSlides();
  } else {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Failed to add slide', 'error');
  }
}

async function deleteSlide(id) {
  if (!confirm('Delete this slide?')) return;
  const res = await fetch(`/api/slides/${id}`, { method: 'DELETE' });
  if (res.ok) { loadSlides(); toast('Slide deleted'); }
  else toast('Delete failed', 'error');
}

function editSlide(id) {
  const s = _slides.find(x => x.id === id);
  if (!s) return;
  const html = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px" id="slide-edit-modal">
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:28px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;position:relative">
      <h3 style="margin:0 0 18px">Edit Slide</h3>
      <div style="display:grid;gap:10px">
        <div class="field"><label>Background Image URL</label><input id="es-image-url" type="url" value="${esc(s.image_url)}" /></div>
        <label class="upload-zone" for="es-file" style="margin:0;padding:10px">
          <p style="font-size:.78rem;margin:0">Upload new image (replaces current)</p>
          <input type="file" id="es-file" accept="image/*" />
        </label>
        <div class="field"><label>Video URL (MP4/WebM)</label><input id="es-video-url" type="url" value="${esc(s.video_url)}" /></div>
        <div class="field"><label>Headline</label><input id="es-headline" type="text" value="${esc(s.headline)}" /></div>
        <div class="field"><label>Subheading</label><textarea id="es-sub" rows="2">${esc(s.sub)}</textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>CTA 1 Label</label><input id="es-cta1-text" type="text" value="${esc(s.cta1_text)}" /></div>
          <div class="field"><label>CTA 1 Link</label><input id="es-cta1-link" type="text" value="${esc(s.cta1_link)}" /></div>
          <div class="field"><label>CTA 2 Label</label><input id="es-cta2-text" type="text" value="${esc(s.cta2_text)}" /></div>
          <div class="field"><label>CTA 2 Link</label><input id="es-cta2-link" type="text" value="${esc(s.cta2_link)}" /></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>Overlay Colour</label><input id="es-overlay-color" type="color" value="${esc(s.overlay_color||'#000000')}" /></div>
          <div class="field"><label>Overlay Opacity (0–1)</label><input id="es-overlay-opacity" type="number" min="0" max="1" step="0.05" value="${s.overlay_opacity??0.5}" /></div>
        </div>
        <div class="show-row">
          <label>Visible on site</label>
          <label class="toggle-sw"><input type="checkbox" id="es-visible" ${s.visible ? 'checked' : ''} /><span class="toggle-sl"></span></label>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn btn-primary" onclick="saveEditSlide(${id})">Save Changes</button>
        <button class="btn btn-ghost" onclick="document.getElementById('slide-edit-modal').remove()">Cancel</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function saveEditSlide(id) {
  const fd = new FormData();
  fd.append('headline', document.getElementById('es-headline').value.trim());
  fd.append('sub', document.getElementById('es-sub').value.trim());
  fd.append('cta1_text', document.getElementById('es-cta1-text').value.trim());
  fd.append('cta1_link', document.getElementById('es-cta1-link').value.trim());
  fd.append('cta2_text', document.getElementById('es-cta2-text').value.trim());
  fd.append('cta2_link', document.getElementById('es-cta2-link').value.trim());
  fd.append('overlay_color', document.getElementById('es-overlay-color').value);
  fd.append('overlay_opacity', document.getElementById('es-overlay-opacity').value);
  fd.append('visible', document.getElementById('es-visible').checked ? '1' : '0');
  fd.append('image_url', document.getElementById('es-image-url').value.trim());
  fd.append('video_url', document.getElementById('es-video-url').value.trim());
  const fileEl = document.getElementById('es-file');
  if (fileEl?.files[0]) fd.append('file', fileEl.files[0]);

  const res = await fetch(`/api/slides/${id}`, { method: 'PUT', body: fd });
  if (res.ok) {
    document.getElementById('slide-edit-modal')?.remove();
    loadSlides();
    toast('Slide updated');
  } else {
    const err = await res.json().catch(() => ({}));
    toast(err.error || 'Update failed', 'error');
  }
}

/* ── Settings ── */
async function loadSettings() {
  const s = await fetch('/api/settings').then(r => r.json());
  document.getElementById('s-instagram').value = s.instagram_url || '';
  document.getElementById('s-facebook').value  = s.facebook_url  || '';
  document.getElementById('s-tiktok').value    = s.tiktok_url    || '';
  document.getElementById('s-twitter').value   = s.twitter_url   || '';
  document.getElementById('s-youtube').value   = s.youtube_url   || '';
  document.getElementById('s-phone').value     = s.phone         || '';
  document.getElementById('s-email').value     = s.email         || '';
  document.getElementById('s-address').value   = s.address       || '';
  // Hero
  document.getElementById('s-hero-tag').value          = s.hero_tag          || '';
  document.getElementById('s-hero-headline').value     = s.hero_headline     || '';
  document.getElementById('s-hero-sub').value          = s.hero_sub          || '';
  document.getElementById('s-hero-cta1-text').value    = s.hero_cta1_text    || '';
  document.getElementById('s-hero-cta1-link').value    = s.hero_cta1_link    || '';
  document.getElementById('s-hero-cta2-text').value    = s.hero_cta2_text    || '';
  document.getElementById('s-hero-cta2-link').value    = s.hero_cta2_link    || '';
  document.getElementById('s-hero-bg-url').value       = s.hero_bg_url       || '';
  document.getElementById('s-hero-tag-color').value     = s.hero_tag_color     || '#1A6FFF';
  document.getElementById('s-hero-headline-color').value = s.hero_headline_color || '#F5F5F5';
  document.getElementById('s-hero-accent-color').value  = s.hero_accent_color  || '#6B6B6B';
  document.getElementById('s-hero-sub-color').value     = s.hero_sub_color     || '#C4C4C4';
}

async function saveSettings(group) {
  let body = {};
  if (group === 'social') {
    body = {
      instagram_url: document.getElementById('s-instagram').value,
      facebook_url:  document.getElementById('s-facebook').value,
      tiktok_url:    document.getElementById('s-tiktok').value,
      twitter_url:   document.getElementById('s-twitter').value,
      youtube_url:   document.getElementById('s-youtube').value,
    };
  } else if (group === 'contact') {
    body = {
      phone:   document.getElementById('s-phone').value,
      email:   document.getElementById('s-email').value,
      address: document.getElementById('s-address').value,
    };
  } else if (group === 'password') {
    const current_password = document.getElementById('s-current-password').value;
    const new_password     = document.getElementById('s-password').value;
    if (!current_password || !new_password) return toast('Enter current and new password', 'error');
    const pwRes = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password, new_password }),
    });
    const pwData = await pwRes.json();
    if (pwRes.ok) {
      toast('Password updated');
      document.getElementById('s-current-password').value = '';
      document.getElementById('s-password').value = '';
    } else {
      toast(pwData.error || 'Password update failed', 'error');
    }
    return;
  } else if (group === 'hero') {
    body = {
      hero_tag:            document.getElementById('s-hero-tag').value,
      hero_headline:       document.getElementById('s-hero-headline').value,
      hero_sub:            document.getElementById('s-hero-sub').value,
      hero_cta1_text:      document.getElementById('s-hero-cta1-text').value,
      hero_cta1_link:      document.getElementById('s-hero-cta1-link').value,
      hero_cta2_text:      document.getElementById('s-hero-cta2-text').value,
      hero_cta2_link:      document.getElementById('s-hero-cta2-link').value,
      hero_bg_url:         document.getElementById('s-hero-bg-url').value,
      hero_tag_color:      document.getElementById('s-hero-tag-color').value,
      hero_headline_color: document.getElementById('s-hero-headline-color').value,
      hero_accent_color:   document.getElementById('s-hero-accent-color').value,
      hero_sub_color:      document.getElementById('s-hero-sub-color').value,
    };
  }

  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    toast('Settings saved');
    if (group === 'password') document.getElementById('s-password').value = '';
  } else toast('Save failed', 'error');
}

/* ── 2FA management ── */
async function startTotpSetup() {
  try {
    const d = await fetch('/api/auth/totp/setup').then(r => r.json());
    document.getElementById('totp-secret-display').value = d.secret || '';
    const qrEl = document.getElementById('totp-qr');
    if (d.qrDataUrl) {
      qrEl.innerHTML = `<img src="${d.qrDataUrl}" alt="QR Code" style="width:160px;height:160px;border-radius:8px" />`;
    } else {
      qrEl.innerHTML = `<p style="font-size:.8rem;color:var(--muted)">Scan not available — enter the secret key manually.</p>`;
    }
    document.getElementById('totp-setup-area').style.display = 'block';
    document.getElementById('totp-action-btns').style.display = 'none';
  } catch { toast('Could not start 2FA setup', 'error'); }
}

function cancelTotpSetup() {
  document.getElementById('totp-setup-area').style.display = 'none';
  document.getElementById('totp-action-btns').style.display = 'flex';
  document.getElementById('totp-verify-code').value = '';
}

async function enableTotp() {
  const token = document.getElementById('totp-verify-code').value.replace(/\s/g, '');
  if (!token) return toast('Enter the 6-digit code from your app', 'error');
  const res  = await fetch('/api/auth/totp/enable', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token }) });
  const data = await res.json();
  if (res.ok) {
    toast('2FA enabled');
    document.getElementById('totp-status-badge').textContent = '✓ Enabled';
    document.getElementById('totp-status-badge').style.color = 'var(--green)';
    cancelTotpSetup();
    document.getElementById('totp-enable-btn').style.display  = 'none';
    document.getElementById('totp-disable-btn').style.display = '';
  } else {
    toast(data.error || 'Invalid code', 'error');
  }
}

async function disableTotp() {
  const password = document.getElementById('totp-disable-password').value;
  if (!password) return toast('Enter your password to confirm', 'error');
  const res  = await fetch('/api/auth/totp/disable', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password }) });
  const data = await res.json();
  if (res.ok) {
    toast('2FA disabled');
    document.getElementById('totp-status-badge').textContent = 'Disabled';
    document.getElementById('totp-status-badge').style.color = 'var(--amber)';
    document.getElementById('totp-disable-area').style.display    = 'none';
    document.getElementById('totp-disable-password').value        = '';
    document.getElementById('totp-enable-btn').style.display  = '';
    document.getElementById('totp-disable-btn').style.display = 'none';
  } else {
    toast(data.error || 'Failed to disable 2FA', 'error');
  }
}

/* ── Helpers ── */
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function statusBadge(s) {
  const map = { Pending:'badge-pending', Confirmed:'badge-confirmed', Completed:'badge-completed', Cancelled:'badge-cancelled' };
  return `<span class="badge ${map[s] || ''}">${esc(s)}</span>`;
}
function tierBadge(t) {
  if (!t) return '<span style="color:var(--muted)">—</span>';
  const map = { bronze:'badge-bronze', silver:'badge-silver', gold:'badge-gold' };
  return `<span class="badge ${map[t] || ''}">${t.charAt(0).toUpperCase() + t.slice(1)}</span>`;
}

/* ── Site Builder tabs ── */
document.querySelectorAll('.btab').forEach(tab => {
  tab.addEventListener('click', () => {
    const panel = tab.dataset.panel;
    document.querySelectorAll('.btab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.bpanel').forEach(p => p.classList.toggle('active', p.id === `bpanel-${panel}`));
    if (panel === 'slideshow') loadSlides();
  });
});

/* ── Builder helpers ── */
function gv(id) { const e = document.getElementById(id); return e ? e.value : ''; }
function gc(id) { const e = document.getElementById(id); return e ? e.checked : false; }
function setVal(id, v) { const e = document.getElementById(id); if (e) e.value = v ?? ''; }
function setCheck(id, v) { const e = document.getElementById(id); if (e) e.checked = !!v; }
function setColor(id, v) {
  const e = document.getElementById(id);
  if (!e) return;
  if (/^#[0-9A-Fa-f]{3,8}$/.test(v)) e.value = v;
}
function syncColorHex(colorId, hexId) {
  const hex = document.getElementById(hexId)?.value.trim();
  if (hex && /^#[0-9A-Fa-f]{3,8}$/.test(hex)) setColor(colorId, hex);
}
function previewFont(sel, previewId) {
  const name = sel.value;
  loadAdminFont(name);
  const prev = document.getElementById(previewId);
  if (prev) prev.style.fontFamily = `'${name}', sans-serif`;
}
function loadAdminFont(name) {
  if (!name || name === 'Bebas Neue' || name === 'DM Sans') return;
  if (document.querySelector(`link[data-adminfont="${name}"]`)) return;
  const lk = document.createElement('link');
  lk.rel = 'stylesheet'; lk.dataset.adminfont = name;
  lk.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g,'+')}:wght@400;700&display=swap`;
  document.head.appendChild(lk);
}

/* ── Load builder ── */
async function loadBuilder() {
  const s = await fetch('/api/settings').then(r => r.json());

  // Global typography
  setVal('b-global-heading-font', s.global_heading_font || 'Bebas Neue');
  setVal('b-global-body-font',    s.global_body_font    || 'DM Sans');
  setVal('b-global-body-size',    s.global_body_size    || '16');
  setVal('b-global-line-height',  s.global_body_line_height || '1.7');
  setVal('b-global-letter-spacing', s.global_heading_letter_spacing || '0.06');
  // Global colours
  setColor('b-global-brand-color',   s.global_brand_color   || '#1A6FFF');
  setColor('b-global-body-color',    s.global_body_color    || '#F5F5F5');
  setColor('b-global-heading-color', s.global_heading_color || '#F5F5F5');
  setVal('b-global-brand-color-hex',   s.global_brand_color   || '#1A6FFF');
  setVal('b-global-body-color-hex',    s.global_body_color    || '#F5F5F5');
  setVal('b-global-heading-color-hex', s.global_heading_color || '#F5F5F5');
  setVal('b-global-btn-radius', s.global_btn_radius || '6');
  // Apply font previews
  ['b-global-heading-font','b-global-body-font'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) { loadAdminFont(sel.value); }
  });
  const hp = document.getElementById('b-heading-preview');
  if (hp) hp.style.fontFamily = `'${s.global_heading_font || 'Bebas Neue'}', sans-serif`;
  const bp = document.getElementById('b-body-preview');
  if (bp) bp.style.fontFamily = `'${s.global_body_font || 'DM Sans'}', sans-serif`;

  // Navbar
  setCheck('b-nav-show', s.nav_show !== '0');
  setVal('b-nav-logo-text', s.nav_logo_text || 'CLEAN TORQUE');
  setVal('b-nav-logo-sub',  s.nav_logo_sub  || 'Detailing');
  setVal('b-nav-cta-text',  s.nav_cta_text  || 'Book Now');
  setVal('b-nav-cta-link',  s.nav_cta_link  || '#booking');
  setColor('b-nav-bg-color', '#0D0D0D');
  setVal('b-nav-bg-color-hex', s.nav_bg_color || 'rgba(13,13,13,0.92)');

  // Hero
  setCheck('b-hero-show', s.hero_show !== '0');
  setVal('b-hero-padding-top', s.hero_padding_top || '80');
  setVal('b-hero-overlay',     s.hero_overlay_opacity || '0.55');
  setVal('b-hero-tag',         s.hero_tag || '');
  setVal('b-hero-headline',    s.hero_headline || '');
  setVal('b-hero-sub',         s.hero_sub || '');
  setVal('b-hero-cta1-text',   s.hero_cta1_text || '');
  setVal('b-hero-cta1-link',   s.hero_cta1_link || '');
  setVal('b-hero-cta2-text',   s.hero_cta2_text || '');
  setVal('b-hero-cta2-link',   s.hero_cta2_link || '');
  setVal('b-hero-bg-url',      s.hero_bg_url || '');
  setColor('b-hero-tag-color',      s.hero_tag_color      || '#1A6FFF');
  setColor('b-hero-headline-color', s.hero_headline_color || '#F5F5F5');
  setColor('b-hero-accent-color',   s.hero_accent_color   || '#6B6B6B');
  setColor('b-hero-sub-color',      s.hero_sub_color      || '#C4C4C4');

  // Stats
  setCheck('b-stats-show', s.stats_show !== '0');
  setVal('b-stat1-num',   s.stat1_num   || '500+'); setVal('b-stat1-label', s.stat1_label || 'Vehicles Detailed');
  setVal('b-stat2-num',   s.stat2_num   || '4.9★'); setVal('b-stat2-label', s.stat2_label || 'Average Rating');
  setVal('b-stat3-num',   s.stat3_num   || '3');    setVal('b-stat3-label', s.stat3_label || 'Subscription Tiers');
  setVal('b-stat4-num',   s.stat4_num   || '24h');  setVal('b-stat4-label', s.stat4_label || 'Booking Response');
  setColor('b-stats-num-color',   s.stats_num_color   || '#1A6FFF');
  setColor('b-stats-label-color', s.stats_label_color || '#6B6B6B');
  setVal('b-stats-padding-top',    s.stats_padding_top    || '36');
  setVal('b-stats-padding-bottom', s.stats_padding_bottom || '36');

  // Packages
  setCheck('b-packages-show', s.packages_show !== '0');
  setVal('b-packages-title',          s.packages_title        || 'OUR PACKAGES');
  setVal('b-packages-sub',            s.packages_sub          || '');
  setColor('b-packages-title-color',  s.packages_title_color  || '#F5F5F5');
  setVal('b-packages-padding-top',    s.packages_padding_top    || '100');
  setVal('b-packages-padding-bottom', s.packages_padding_bottom || '100');

  // Booking
  setCheck('b-booking-show', s.booking_show !== '0');
  setVal('b-booking-title',          s.booking_title         || 'BUILD YOUR PLAN');
  setVal('b-booking-sub',            s.booking_sub           || '');
  setColor('b-booking-title-color',  s.booking_title_color   || '#F5F5F5');
  setVal('b-booking-padding-top',    s.booking_padding_top    || '100');
  setVal('b-booking-padding-bottom', s.booking_padding_bottom || '100');

  // Gallery
  setCheck('b-gallery-show', s.gallery_show !== '0');
  setVal('b-gallery-title',          s.gallery_title         || 'THE RESULTS SPEAK');
  setVal('b-gallery-sub',            s.gallery_sub           || '');
  setColor('b-gallery-title-color',  s.gallery_title_color   || '#F5F5F5');
  setVal('b-gallery-padding-top',    s.gallery_padding_top    || '100');
  setVal('b-gallery-padding-bottom', s.gallery_padding_bottom || '100');

  // Contact
  setCheck('b-contact-show', s.contact_show !== '0');
  setVal('b-contact-title',          s.contact_title         || 'GET IN TOUCH');
  setVal('b-contact-sub',            s.contact_sub           || '');
  setColor('b-contact-title-color',  s.contact_title_color   || '#F5F5F5');
  setVal('b-contact-padding-top',    s.contact_padding_top    || '100');
  setVal('b-contact-padding-bottom', s.contact_padding_bottom || '100');

  // Footer
  setCheck('b-footer-show', s.footer_show !== '0');
  setVal('b-footer-tagline',   s.footer_tagline   || '');
  setVal('b-footer-copyright', s.footer_copyright || '');
}

/* ── Save builder ── */
async function saveBuilder(panel) {
  let body = {};
  if (panel === 'typography') {
    body = {
      global_heading_font: gv('b-global-heading-font'),
      global_body_font:    gv('b-global-body-font'),
      global_body_size:    gv('b-global-body-size'),
      global_body_line_height:          gv('b-global-line-height'),
      global_heading_letter_spacing:    gv('b-global-letter-spacing'),
    };
  } else if (panel === 'colors') {
    body = {
      global_brand_color:   gv('b-global-brand-color'),
      global_body_color:    gv('b-global-body-color'),
      global_heading_color: gv('b-global-heading-color'),
      global_btn_radius:    gv('b-global-btn-radius'),
    };
  } else if (panel === 'nav') {
    body = {
      nav_show:      gc('b-nav-show') ? '1' : '0',
      nav_logo_text: gv('b-nav-logo-text'),
      nav_logo_sub:  gv('b-nav-logo-sub'),
      nav_cta_text:  gv('b-nav-cta-text'),
      nav_cta_link:  gv('b-nav-cta-link'),
      nav_bg_color:  gv('b-nav-bg-color-hex') || gv('b-nav-bg-color'),
    };
  } else if (panel === 'hero-layout') {
    body = {
      hero_show:            gc('b-hero-show') ? '1' : '0',
      hero_padding_top:     gv('b-hero-padding-top'),
      hero_overlay_opacity: gv('b-hero-overlay'),
    };
  } else if (panel === 'hero-content') {
    body = {
      hero_tag:       gv('b-hero-tag'),
      hero_headline:  gv('b-hero-headline'),
      hero_sub:       gv('b-hero-sub'),
      hero_cta1_text: gv('b-hero-cta1-text'),
      hero_cta1_link: gv('b-hero-cta1-link'),
      hero_cta2_text: gv('b-hero-cta2-text'),
      hero_cta2_link: gv('b-hero-cta2-link'),
      hero_bg_url:    gv('b-hero-bg-url'),
    };
  } else if (panel === 'hero-colors') {
    body = {
      hero_tag_color:      gv('b-hero-tag-color'),
      hero_headline_color: gv('b-hero-headline-color'),
      hero_accent_color:   gv('b-hero-accent-color'),
      hero_sub_color:      gv('b-hero-sub-color'),
    };
  } else if (panel === 'slideshow-settings') {
    body = {
      slideshow_enabled:    gc('b-slideshow-enabled') ? '1' : '0',
      slideshow_transition: gv('b-slideshow-transition'),
      slideshow_interval:   gv('b-slideshow-interval'),
      slideshow_autoplay:   gc('b-slideshow-autoplay') ? '1' : '0',
      slideshow_dots:       gc('b-slideshow-dots') ? '1' : '0',
      slideshow_arrows:     gc('b-slideshow-arrows') ? '1' : '0',
    };
  } else if (panel === 'stats') {
    body = {
      stats_show:           gc('b-stats-show') ? '1' : '0',
      stat1_num:   gv('b-stat1-num'),   stat1_label: gv('b-stat1-label'),
      stat2_num:   gv('b-stat2-num'),   stat2_label: gv('b-stat2-label'),
      stat3_num:   gv('b-stat3-num'),   stat3_label: gv('b-stat3-label'),
      stat4_num:   gv('b-stat4-num'),   stat4_label: gv('b-stat4-label'),
      stats_num_color:      gv('b-stats-num-color'),
      stats_label_color:    gv('b-stats-label-color'),
      stats_padding_top:    gv('b-stats-padding-top'),
      stats_padding_bottom: gv('b-stats-padding-bottom'),
    };
  } else if (panel === 'packages') {
    body = {
      packages_show:           gc('b-packages-show') ? '1' : '0',
      packages_title:          gv('b-packages-title'),
      packages_sub:            gv('b-packages-sub'),
      packages_title_color:    gv('b-packages-title-color'),
      packages_bg_color:       gv('b-packages-bg-hex') || '',
      packages_padding_top:    gv('b-packages-padding-top'),
      packages_padding_bottom: gv('b-packages-padding-bottom'),
    };
  } else if (panel === 'booking') {
    body = {
      booking_show:           gc('b-booking-show') ? '1' : '0',
      booking_title:          gv('b-booking-title'),
      booking_sub:            gv('b-booking-sub'),
      booking_title_color:    gv('b-booking-title-color'),
      booking_bg_color:       gv('b-booking-bg-hex') || '',
      booking_padding_top:    gv('b-booking-padding-top'),
      booking_padding_bottom: gv('b-booking-padding-bottom'),
    };
  } else if (panel === 'gallery') {
    body = {
      gallery_show:           gc('b-gallery-show') ? '1' : '0',
      gallery_title:          gv('b-gallery-title'),
      gallery_sub:            gv('b-gallery-sub'),
      gallery_title_color:    gv('b-gallery-title-color'),
      gallery_bg_color:       gv('b-gallery-bg-hex') || '',
      gallery_padding_top:    gv('b-gallery-padding-top'),
      gallery_padding_bottom: gv('b-gallery-padding-bottom'),
    };
  } else if (panel === 'contact') {
    body = {
      contact_show:           gc('b-contact-show') ? '1' : '0',
      contact_title:          gv('b-contact-title'),
      contact_sub:            gv('b-contact-sub'),
      contact_title_color:    gv('b-contact-title-color'),
      contact_bg_color:       gv('b-contact-bg-hex') || '',
      contact_padding_top:    gv('b-contact-padding-top'),
      contact_padding_bottom: gv('b-contact-padding-bottom'),
    };
  } else if (panel === 'footer') {
    body = {
      footer_show:      gc('b-footer-show') ? '1' : '0',
      footer_tagline:   gv('b-footer-tagline'),
      footer_copyright: gv('b-footer-copyright'),
      footer_bg_color:  gv('b-footer-bg-hex') || '',
    };
  }

  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) { toast('Saved — live site updated'); previewRefreshIfActive(); }
  else toast('Save failed', 'error');
}

/* ── Export / Import ── */
async function exportSettings() {
  const s = await fetch('/api/settings').then(r => r.json());
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ctd-settings-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
}
async function importSettings(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) { toast('Settings imported — reloading…'); setTimeout(() => loadBuilder(), 800); }
    else toast('Import failed', 'error');
  } catch (_) { toast('Invalid JSON file', 'error'); }
  e.target.value = '';
}

/* ── Live Preview ── */
let previewDevice = { w: 375, h: 667, type: 'mobile' };
let previewLandscape = false;
let previewFull = false;
let previewInitialized = false;

function initPreview() {
  if (!previewInitialized) {
    const saved = localStorage.getItem('ct_previewDevice');
    if (saved) {
      try {
        previewDevice = JSON.parse(saved);
        document.querySelectorAll('.device-btn').forEach(btn => {
          btn.classList.toggle('active',
            parseInt(btn.dataset.w) === previewDevice.w && parseInt(btn.dataset.h) === previewDevice.h);
        });
      } catch(_) {}
    }
    window.addEventListener('resize', () => { if (currentSection === 'preview') updatePreview(); });
    previewInitialized = true;
  }
  updatePreview();
}

function setDevice(btn) {
  document.querySelectorAll('.device-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  previewDevice = {
    w: parseInt(btn.dataset.w),
    h: parseInt(btn.dataset.h),
    type: btn.dataset.type
  };
  previewLandscape = false;
  document.getElementById('rotateBtn').classList.remove('active');
  localStorage.setItem('ct_previewDevice', JSON.stringify(previewDevice));
  updatePreview();
}

function rotateDevice() {
  previewLandscape = !previewLandscape;
  document.getElementById('rotateBtn').classList.toggle('active', previewLandscape);
  updatePreview();
}

function applyCustomSize() {
  const w = parseInt(document.getElementById('customW').value);
  const h = parseInt(document.getElementById('customH').value);
  if (!w || !h || w < 200 || h < 200) { toast('Enter valid width and height (min 200)', 'error'); return; }
  document.querySelectorAll('.device-btn').forEach(b => b.classList.remove('active'));
  previewDevice = { w, h, type: w <= 425 ? 'mobile' : w <= 768 ? 'tablet' : 'laptop' };
  previewLandscape = false;
  updatePreview();
}

function updatePreview() {
  const dw = previewLandscape ? previewDevice.h : previewDevice.w;
  const dh = previewLandscape ? previewDevice.w : previewDevice.h;
  const type = previewDevice.type;
  const isMobile  = type === 'mobile';
  const isTablet  = type === 'tablet';
  const isBrowser = type === 'laptop' || type === 'desktop';

  const iframe = document.getElementById('previewIframe');
  const screen = document.getElementById('deviceScreen');
  iframe.style.width  = dw + 'px';
  iframe.style.height = dh + 'px';
  screen.style.width  = dw + 'px';
  screen.style.height = dh + 'px';

  const frame = document.getElementById('deviceFrame');
  frame.className = 'device-frame ' + (isMobile ? 'frame-mobile' : isTablet ? 'frame-tablet' : 'frame-laptop');

  const mTop   = document.getElementById('frameMobileTop');
  const mBot   = document.getElementById('frameMobileBottom');
  const chrome = document.getElementById('frameChromeBar');
  mTop.style.display   = (isMobile || isTablet) ? 'flex' : 'none';
  mBot.style.display   = isMobile ? 'flex' : 'none';
  chrome.style.display = isBrowser ? 'flex' : 'none';
  if (isBrowser) {
    document.getElementById('chromeUrlText').textContent =
      window.location.hostname + (window.location.port ? ':' + window.location.port : '');
  }

  // Natural shell dimensions (before scale)
  const borderW  = isMobile ? 10 : isTablet ? 8 : 2;
  const mTopH    = (isMobile || isTablet) ? 28 : 0;
  const mBotH    = isMobile ? 24 : 0;
  const chromeH  = isBrowser ? 36 : 0;
  const naturalW = dw + borderW * 2;
  const naturalH = dh + mTopH + mBotH + chromeH + borderW * 2;

  // Fit-to-viewport scale
  const vp  = document.getElementById('previewViewport');
  const PAD = 40;
  const scale = Math.min(
    (vp.offsetWidth  - PAD * 2) / naturalW,
    (vp.offsetHeight - PAD * 2) / naturalH,
    1
  );
  const left = (vp.offsetWidth  - naturalW * scale) / 2;
  const top  = (vp.offsetHeight - naturalH * scale) / 2;

  const shell = document.getElementById('deviceShell');
  shell.style.transformOrigin = 'top left';
  shell.style.transform = `scale(${scale})`;
  shell.style.left = left + 'px';
  shell.style.top  = top  + 'px';

  document.getElementById('previewSizeLabel').textContent = `${dw} × ${dh} px`;
  document.getElementById('previewScaleLabel').textContent = Math.round(scale * 100) + '%';
}

function refreshPreviewIframe() {
  const f = document.getElementById('previewIframe');
  try { f.contentWindow.location.reload(); } catch(_) { f.src = f.src; }
}

function previewRefreshIfActive() {
  if (currentSection === 'preview') setTimeout(refreshPreviewIframe, 300);
}

function toggleFullPreview() {
  previewFull = !previewFull;
  document.getElementById('sidebar').style.display  = previewFull ? 'none' : '';
  document.querySelector('.top-bar').style.display  = previewFull ? 'none' : '';
  const btn = document.getElementById('fullPreviewBtn');
  btn.classList.toggle('fullactive', previewFull);
  document.getElementById('fullPreviewIconExpand').style.display   = previewFull ? 'none' : '';
  document.getElementById('fullPreviewIconContract').style.display = previewFull ? ''     : 'none';
  document.getElementById('fullPreviewBtnText').textContent = previewFull ? 'Exit Preview' : 'Full Preview';
  setTimeout(updatePreview, 50);
}

function copyPreviewLink() {
  const dw = previewLandscape ? previewDevice.h : previewDevice.w;
  const dh = previewLandscape ? previewDevice.w : previewDevice.h;
  const url = `${window.location.origin}/?preview=1&w=${dw}&h=${dh}`;
  navigator.clipboard.writeText(url)
    .then(() => toast('Preview link copied'))
    .catch(() => toast('Copy failed', 'error'));
}

/* ════════════════════════════════════════════════════════════
   PAYMENTS
════════════════════════════════════════════════════════════ */

/* ── Tab switching ── */
document.querySelectorAll('.ptab').forEach(btn => {
  btn.addEventListener('click', () => switchPayTab(btn.dataset.ptab));
});
function switchPayTab(name) {
  document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('active', b.dataset.ptab === name));
  document.querySelectorAll('.ppanel').forEach(p => p.classList.toggle('active', p.id === 'ppanel-' + name));
  if (name === 'overview')     loadPaymentOverview();
  if (name === 'packages')     loadSubPackages();
  if (name === 'subscribers')  loadSubscribers();
  if (name === 'history')      loadPaymentHistory();
  if (name === 'bank')         loadBankSettings();
}

async function loadPayments() {
  const cfg = await fetch('/api/stripe-config').then(r => r.json()).catch(() => ({ configured: false }));
  document.getElementById('stripe-notice').style.display = cfg.configured ? 'none' : 'flex';
  loadPaymentOverview();
}

/* ── Overview ── */
async function loadPaymentOverview() {
  try {
    const d = await fetch('/api/payment-dashboard').then(r => r.json());
    document.getElementById('ps-active').textContent    = d.activeCount;
    document.getElementById('ps-failed').textContent    = d.failedCount;
    document.getElementById('ps-cancelled').textContent = d.cancelledCount;
    const mrr = (d.mrr / 100).toFixed(2);
    document.getElementById('ps-mrr').textContent = '£' + mrr;
    const tbody = document.getElementById('ps-recent-body');
    if (!d.recentPayments?.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No transactions yet</td></tr>';
    } else {
      tbody.innerHTML = d.recentPayments.map(p => `
        <tr>
          <td>${p.created_at?.slice(0,10) || '—'}</td>
          <td class="td-name">${p.customer_name}<br><small style="color:var(--muted)">${p.customer_email}</small></td>
          <td>${p.package_name}</td>
          <td>£${(p.amount_pence/100).toFixed(2)}</td>
          <td><span class="badge ${payStatusBadge(p.status)}">${p.status}</span></td>
        </tr>`).join('');
    }
  } catch(e) { console.error(e); }
}

function payStatusBadge(s) {
  return { Paid:'badge-confirmed', Failed:'badge-cancelled', Refunded:'badge-pending' }[s] || '';
}

/* ── Subscription Packages ── */
let _subPkgs = [];
async function loadSubPackages() {
  _subPkgs = await fetch('/api/sub-packages/all').then(r => r.json()).catch(() => []);
  renderSubPkgGrid();
}
function renderSubPkgGrid() {
  const grid = document.getElementById('spkg-grid');
  if (!_subPkgs.length) { grid.innerHTML = '<p style="color:var(--muted);font-size:.83rem">No packages yet. Add one above.</p>'; return; }
  grid.innerHTML = _subPkgs.map(p => `
    <div class="sub-pkg-card">
      <div class="sub-pkg-card-head">
        <div class="sub-pkg-name">${p.name} ${p.popular ? '<span class="popular-badge-admin">Popular</span>':''}</div>
        <div>${p.visible ? '<span class="badge badge-confirmed">Visible</span>' : '<span class="badge badge-cancelled">Hidden</span>'}</div>
      </div>
      <div class="sub-pkg-price">£${(p.price_pence/100).toFixed(2)}<span>/month</span></div>
      <p style="font-size:.75rem;color:var(--muted);margin:6px 0 10px">${p.description || ''}</p>
      <ul style="font-size:.75rem;color:var(--text2);padding-left:14px;margin-bottom:14px">
        ${(p.features||[]).map(f=>`<li>${f}</li>`).join('')}
      </ul>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-xs" onclick="editSubPkg(${p.id})">Edit</button>
        <button class="btn btn-danger btn-xs" onclick="deleteSubPkg(${p.id},'${p.name}')">Delete</button>
      </div>
    </div>`).join('');
}

function editSubPkg(id) {
  const p = _subPkgs.find(x => x.id === id);
  if (!p) return;
  document.getElementById('spkg-edit-id').value = id;
  document.getElementById('spkg-name').value  = p.name;
  document.getElementById('spkg-price').value = (p.price_pence/100).toFixed(2);
  document.getElementById('spkg-desc').value  = p.description || '';
  document.getElementById('spkg-features').value = (p.features||[]).join('\n');
  document.getElementById('spkg-visible').checked = !!p.visible;
  document.getElementById('spkg-popular').checked = !!p.popular;
}

function resetSubPkgForm() {
  document.getElementById('spkg-edit-id').value = '';
  ['spkg-name','spkg-price','spkg-desc','spkg-features'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('spkg-visible').checked = true;
  document.getElementById('spkg-popular').checked = false;
}

async function saveSubPackage() {
  const editId = document.getElementById('spkg-edit-id').value;
  const name   = document.getElementById('spkg-name').value.trim();
  const price  = parseFloat(document.getElementById('spkg-price').value);
  if (!name || isNaN(price)) { toast('Package name and price are required', 'error'); return; }
  const featureText = document.getElementById('spkg-features').value;
  const features = featureText.split('\n').map(f=>f.trim()).filter(Boolean);
  const body = {
    name, price_pence: Math.round(price * 100),
    description: document.getElementById('spkg-desc').value.trim(),
    features,
    visible: document.getElementById('spkg-visible').checked ? 1 : 0,
    popular: document.getElementById('spkg-popular').checked ? 1 : 0,
  };
  const url    = editId ? `/api/sub-packages/${editId}` : '/api/sub-packages';
  const method = editId ? 'PUT' : 'POST';
  const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (res.ok) { toast('Package saved'); resetSubPkgForm(); loadSubPackages(); }
  else toast('Save failed', 'error');
}

async function deleteSubPkg(id, name) {
  if (!confirm(`Delete package "${name}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/sub-packages/${id}`, { method: 'DELETE' });
  if (res.ok) { toast('Package deleted'); loadSubPackages(); }
  else toast('Delete failed', 'error');
}

/* ── Subscribers ── */
async function loadSubscribers() {
  const search = document.getElementById('sub-search')?.value || '';
  const status = document.getElementById('sub-status-filter')?.value || 'all';
  const params = new URLSearchParams({ search, status });
  const rows = await fetch('/api/subscribers?' + params).then(r => r.json()).catch(() => []);
  const tbody = document.getElementById('sub-body');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No subscribers yet</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td><div class="td-name">${s.name}</div><div style="font-size:.75rem;color:var(--muted)">${s.email}</div></td>
      <td>${s.package_name}</td>
      <td>${s.start_date?.slice(0,10) || '—'}</td>
      <td>${s.next_payment_date || '—'}</td>
      <td><span class="badge ${subStatusBadge(s.status)}">${s.status}</span></td>
      <td>
        <div style="display:flex;gap:4px">
          ${s.status !== 'Cancelled' ? `<button class="btn btn-danger btn-xs" onclick="cancelSubscriber(${s.id},'${s.name}')">Cancel</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
}

function subStatusBadge(s) {
  return { Active:'badge-confirmed', Failed:'badge-cancelled', Cancelled:'badge-pending' }[s] || '';
}

async function cancelSubscriber(id, name) {
  if (!confirm(`Cancel subscription for "${name}"? They'll keep access until the billing period ends.`)) return;
  const res = await fetch(`/api/subscribers/${id}/cancel`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: '{}' });
  if (res.ok) { toast('Subscription cancelled'); loadSubscribers(); }
  else toast('Cancel failed', 'error');
}

/* ── Payment History ── */
let _payHistory = [];
async function loadPaymentHistory() {
  const search = document.getElementById('ph-search')?.value || '';
  const status = document.getElementById('ph-status-filter')?.value || 'all';
  const params = new URLSearchParams({ search, status });
  _payHistory = await fetch('/api/payment-history?' + params).then(r => r.json()).catch(() => []);
  const tbody = document.getElementById('ph-body');
  if (!_payHistory.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No transactions yet</td></tr>';
    return;
  }
  tbody.innerHTML = _payHistory.map(p => `
    <tr>
      <td>${p.created_at?.slice(0,10) || '—'}</td>
      <td><div class="td-name">${p.customer_name}</div><div style="font-size:.75rem;color:var(--muted)">${p.customer_email}</div></td>
      <td>${p.package_name}</td>
      <td>£${(p.amount_pence/100).toFixed(2)}</td>
      <td><span class="badge ${payStatusBadge(p.status)}">${p.status}</span></td>
    </tr>`).join('');
}

function exportPaymentHistory() {
  if (!_payHistory.length) { toast('No data to export', 'error'); return; }
  const headers = ['Date','Customer Name','Email','Package','Amount (£)','Status'];
  const rows = _payHistory.map(p => [
    p.created_at?.slice(0,10) || '',
    p.customer_name,
    p.customer_email,
    p.package_name,
    (p.amount_pence/100).toFixed(2),
    p.status,
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `payments-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

/* ── Bank & Notification Settings ── */
async function loadBankSettings() {
  try {
    const s = await fetch('/api/payment-settings').then(r => r.json());
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v !== '0'; };
    setVal('bank-holder', s.bank_holder_name);
    setVal('bank-name', s.bank_name);
    setVal('bank-sort', s.bank_sort_code);
    setVal('bank-acct', s.bank_account_number);
    if (document.getElementById('bank-schedule') && s.bank_payout_schedule)
      document.getElementById('bank-schedule').value = s.bank_payout_schedule;
    setVal('bank-next-payout', s.bank_next_payout);
    setVal('notify-email', s.payment_notify_email);
    setVal('notify-from', s.payment_notify_from);
    setChk('notify-new-sub', s.payment_notify_new_sub);
    setChk('notify-failed',  s.payment_notify_failed);
    const wrap = document.getElementById('bank-current-wrap');
    if (s.bank_holder_name) {
      wrap.style.display = 'block';
      document.getElementById('bank-display-name').textContent = s.bank_holder_name + (s.bank_name ? ' · ' + s.bank_name : '');
      document.getElementById('bank-display-mask').textContent =
        'Sort code ' + (s.bank_sort_code || '——') + ' · Account ' + (s.bank_account_number || '————');
      const badge = document.getElementById('bank-payout-badge');
      badge.textContent = (s.bank_payout_schedule || 'weekly') + ' payouts';
    }
  } catch(e) { console.error(e); }
}

async function saveBankSettings() {
  const body = {
    bank_holder_name:    document.getElementById('bank-holder').value.trim(),
    bank_name:           document.getElementById('bank-name').value.trim(),
    bank_sort_code:      document.getElementById('bank-sort').value.trim(),
    bank_account_number: document.getElementById('bank-acct').value.trim(),
    bank_payout_schedule:document.getElementById('bank-schedule').value,
    bank_next_payout:    document.getElementById('bank-next-payout').value,
  };
  const res = await fetch('/api/payment-settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (res.ok) { toast('Bank account saved'); loadBankSettings(); }
  else toast('Save failed', 'error');
}

async function saveNotifySettings() {
  const body = {
    payment_notify_email:   document.getElementById('notify-email').value.trim(),
    payment_notify_from:    document.getElementById('notify-from').value.trim(),
    payment_notify_new_sub: document.getElementById('notify-new-sub').checked ? '1' : '0',
    payment_notify_failed:  document.getElementById('notify-failed').checked ? '1' : '0',
  };
  const res = await fetch('/api/payment-settings', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (res.ok) toast('Notification settings saved');
  else toast('Save failed', 'error');
}

/* ── Privacy tab navigation ── */
document.querySelectorAll('#privacy-tabs .ptab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#privacy-tabs .ptab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('#sec-privacy .ppanel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('priv-' + tab.dataset.ptab).classList.add('active');
    if (tab.dataset.ptab === 'consent') loadConsentLog();
    if (tab.dataset.ptab === 'breach')    loadBreachLog();
    if (tab.dataset.ptab === 'retention') loadRetentionStats();
  });
});

/* ── Privacy section ── */
let _privEmail = '';

function loadPrivacy() { /* nothing to load on nav — search on demand */ }

async function privSearch() {
  const q = document.getElementById('priv-search').value.trim();
  if (!q) return;
  const data = await fetch('/api/admin/privacy/customers?q=' + encodeURIComponent(q)).then(r => r.json());
  const total = data.bookings.length + data.contacts.length + data.subscribers.length;
  if (!total) {
    document.getElementById('priv-results').innerHTML = '<p style="color:var(--muted);font-size:.83rem;padding:12px 0">No records found for that search.</p>';
    document.getElementById('priv-detail').style.display = 'none';
    return;
  }
  const allEmails = [...new Set([
    ...data.bookings.map(r => r.email),
    ...data.contacts.map(r => r.email),
    ...data.subscribers.map(r => r.email),
  ])];
  document.getElementById('priv-results').innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Bookings</th><th>Messages</th><th>Subs</th><th></th></tr></thead>
        <tbody>
          ${allEmails.map(email => {
            const b = data.bookings.filter(r => r.email === email);
            const c = data.contacts.filter(r => r.email === email);
            const s = data.subscribers.filter(r => r.email === email);
            const name = b[0]?.name || c[0]?.name || s[0]?.name || '—';
            return `<tr>
              <td class="td-name">${esc(name)}</td>
              <td>${esc(email)}</td>
              <td>${b.length}</td>
              <td>${c.length}</td>
              <td>${s.length}</td>
              <td><button class="btn btn-ghost btn-xs" onclick="privShowDetail(${JSON.stringify(email).replace(/"/g,'&quot;')}, ${JSON.stringify(name).replace(/"/g,'&quot;')})">View</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function privShowDetail(email, name) {
  _privEmail = email;
  document.getElementById('priv-detail-name').textContent  = name;
  document.getElementById('priv-detail-email').textContent = email;
  document.getElementById('priv-detail').style.display = 'block';
  document.getElementById('priv-detail-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;flex-wrap:wrap">
      <div><div class="card-label" style="margin-bottom:6px">Email</div><div style="font-size:.87rem">${esc(email)}</div></div>
    </div>
    <p style="font-size:.8rem;color:var(--muted);margin-top:16px">Use <strong>Export Data</strong> to download a full JSON report of all records held, or <strong>Erase Personal Data</strong> to anonymise the customer's personal details (payment records are retained for 6 years per HMRC law).</p>`;
  document.getElementById('priv-detail').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function privExport() {
  if (!_privEmail) return;
  const url = '/api/admin/privacy/export?email=' + encodeURIComponent(_privEmail);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'customer-data.json';
  a.click();
}

async function privConfirmDelete() {
  if (!_privEmail) return;
  const reason = prompt(`Enter reason for erasing data for ${_privEmail} (for compliance log):`);
  if (reason === null) return;
  if (!confirm(`This will permanently anonymise all personal data for ${_privEmail}. Payment records will be retained for legal compliance.\n\nThis action cannot be undone. Proceed?`)) return;
  const res = await fetch('/api/admin/privacy/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: _privEmail, reason }),
  });
  if (res.ok) {
    toast('Personal data erased and anonymised');
    document.getElementById('priv-detail').style.display = 'none';
    document.getElementById('priv-results').innerHTML = '';
    document.getElementById('priv-search').value = '';
    _privEmail = '';
  } else {
    toast('Erasure failed', 'error');
  }
}

async function loadConsentLog() {
  const email = document.getElementById('consent-filter-email').value.trim();
  const type  = document.getElementById('consent-filter-type').value;
  let url = '/api/admin/privacy/consent-log?';
  if (email) url += 'email=' + encodeURIComponent(email) + '&';
  if (type)  url += 'type=' + encodeURIComponent(type);
  const data = await fetch(url).then(r => r.json());
  const tbody = document.getElementById('consent-log-body');
  if (!data.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No consent records found</td></tr>'; return; }
  tbody.innerHTML = data.map(r => `
    <tr>
      <td>${esc(r.customer_email || '—')}</td>
      <td>${esc(r.consent_type)}</td>
      <td><span class="badge ${r.given ? 'badge-confirmed' : 'badge-cancelled'}">${r.given ? 'Given' : 'Withdrawn'}</span></td>
      <td>${esc(r.source)}</td>
      <td>${fmtDate(r.created_at)}</td>
    </tr>`).join('');
}

async function loadBreachLog() {
  const data = await fetch('/api/admin/privacy/breach-log').then(r => r.json());
  const tbody = document.getElementById('breach-log-body');
  if (!data.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No breach records</td></tr>'; return; }
  tbody.innerHTML = data.map(r => `
    <tr>
      <td>${r.discovered_at ? r.discovered_at.slice(0,16).replace('T',' ') : '—'}</td>
      <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.nature)}</td>
      <td>${r.individuals_affected || '0'}</td>
      <td><span class="badge ${r.ico_notified ? 'badge-confirmed' : 'badge-pending'}">${r.ico_notified ? 'Yes' : 'No'}</span></td>
      <td>${esc(r.reporter || '—')}</td>
      <td>${fmtDate(r.created_at)}</td>
    </tr>`).join('');
}

async function reportBreach() {
  const nature      = document.getElementById('breach-nature').value.trim();
  const categories  = document.getElementById('breach-categories').value.trim();
  const individuals = document.getElementById('breach-individuals').value;
  const actions     = document.getElementById('breach-actions').value.trim();
  const discovered  = document.getElementById('breach-discovered').value;
  const ico         = document.getElementById('breach-ico').checked;

  if (!nature) { toast('Please describe the nature of the breach', 'error'); return; }

  const res = await fetch('/api/admin/privacy/breach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nature, data_categories: categories,
      individuals_affected: parseInt(individuals) || 0,
      actions_taken: actions,
      discovered_at: discovered || new Date().toISOString(),
      ico_notified: ico,
    }),
  });
  if (res.ok) {
    toast('Breach record logged');
    ['breach-nature','breach-categories','breach-actions'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    document.getElementById('breach-individuals').value = '';
    document.getElementById('breach-ico').checked = false;
    loadBreachLog();
  } else {
    toast('Failed to log breach', 'error');
  }
}

/* ── Retention ── */
async function loadRetentionStats() {
  const data = await fetch('/api/admin/privacy/retention-stats').then(r => r.json()).catch(() => null);
  if (!data) return;
  document.getElementById('ret-bookings').textContent = data.bookings_due;
  document.getElementById('ret-contacts').textContent = data.contacts_due;
  document.getElementById('ret-seclog').textContent   = data.security_log_due;
  document.getElementById('ret-consent').textContent  = data.consent_log_due;
}

async function runRetentionCleanup() {
  if (!confirm('Run retention cleanup now? This will anonymise expired customer records and delete old log entries. This cannot be undone.')) return;
  const csrf = await fetch('/api/auth/csrf').then(r => r.json()).then(d => d.token);
  const data = await fetch('/api/admin/privacy/retention-cleanup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  }).then(r => r.json());
  if (data.ok) {
    const el = document.getElementById('retention-result');
    el.style.display = 'block';
    el.innerHTML = `Cleanup complete at ${new Date(data.ran_at).toLocaleString('en-GB')}:<br>
      Bookings anonymised: <strong>${data.bookings}</strong> &nbsp;|&nbsp;
      Contacts anonymised: <strong>${data.contacts}</strong> &nbsp;|&nbsp;
      Security log rows deleted: <strong>${data.security_log}</strong> &nbsp;|&nbsp;
      Consent entries deleted: <strong>${data.consent_log}</strong>`;
    loadRetentionStats();
    toast('Retention cleanup complete', 'success');
  } else {
    toast('Cleanup failed', 'error');
  }
}

async function genUnsubLink() {
  const email = document.getElementById('unsub-email').value.trim();
  if (!email) { toast('Enter an email address', 'error'); return; }
  const data = await fetch(`/api/admin/privacy/unsubscribe-link?email=${encodeURIComponent(email)}`).then(r => r.json());
  if (data.url) {
    const el = document.getElementById('unsub-link-result');
    el.style.display = 'block';
    el.innerHTML = `<strong style="color:var(--text1)">Unsubscribe link:</strong><br><a href="${data.url}" style="color:var(--blue)">${data.url}</a><br><button class="btn btn-ghost btn-sm" style="margin-top:10px" onclick="navigator.clipboard.writeText('${data.url}').then(()=>toast('Copied','success'))">Copy to clipboard</button>`;
  } else {
    toast(data.error || 'Failed to generate link', 'error');
  }
}

/* ── Init ── */
loadUserInfo();
loadDashboard();
