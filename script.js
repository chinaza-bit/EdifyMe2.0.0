/* =====================================================================
   EDIFY ME — frontend, talking to a REAL backend (Express + Postgres via
   Prisma + Resend for email). No data is stored in the browser: your
   login session lives in an httpOnly cookie the server sets, so nothing
   here uses localStorage/sessionStorage. If the API isn't reachable
   (server not running, wrong URL, CORS), calls below will show an error
   toast — start the backend with `npm run dev` first.
   ===================================================================== */

// Single source of truth for where the API lives. Locally this points at
// your dev server (127.0.0.1, not "localhost" — Live Server serves from
// 127.0.0.1 by default, and the login cookie only works when frontend +
// backend hostnames match exactly). Everywhere else — Vercel, any other
// domain, anyone else's browser — it points at the real deployed backend.
const API = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:4000/api'
  : 'https://edifyme2-0-0.onrender.com/api';

let currentUser = null;      // full user object from GET /users/me, refreshed after actions
let pendingUserId = null;    // user awaiting email verification (signup or unverified login)
let pendingResetUserId = null;
let composerImage = null;    // base64 data URL
let composerMusic = null;    // base64 data URL
let annImage = null;

/* ---------------------- API helper ----------------------
   Standard timeout + retry pattern: every request gets a hard timeout so
   nothing hangs forever, and safe read-only requests (GET) get one silent
   automatic retry on a network failure — covers a request that happens to
   land during a brief restart. POST/PATCH/DELETE are never auto-retried,
   to avoid accidentally double-submitting something like a signup or post. */
async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const isSafeToRetry = method === 'GET';
  const maxAttempts = isSafeToRetry ? 2 : 1;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s hard timeout
    try {
      const res = await fetch(API + path, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        ...opts
      });
      clearTimeout(timeout);

      let data = {};
      try { data = await res.json(); } catch (_) { /* empty body */ }
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        Object.assign(err, data); // carries through fields like userId, needsVerification
        throw err;
      }
      return data;
    } catch (ex) {
      clearTimeout(timeout);
      if (ex.name === 'AbortError') {
        lastErr = new Error('The server took too long to respond. Please try again.');
      } else if (ex instanceof TypeError) {
        // The browser couldn't even complete the request — this is always
        // either a real connectivity problem or a CORS rejection, never a
        // normal "wrong password" type error (those come back as a proper
        // HTTP response and are handled above, not here).
        lastErr = new Error("Can't reach the server. Check your internet connection and try again.");
      } else {
        lastErr = ex; // a real response came back with an error (handled above) — keep its message as-is
      }
      if (isSafeToRetry && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500)); // brief pause before the one retry
        continue;
      }
      throw lastErr;
    }
  }
}

/* ---------------------- small utilities ---------------------- */

// Whitelist-based sanitizer for post content. Post text can only ever come
// from our own formatting toolbar (H1/H2/P/Italic), but a user can still
// paste arbitrary HTML into the contenteditable box, or someone could call
// the API directly — so we strip anything outside this whitelist both
// before sending (composer) and again before rendering (defense in depth,
// since rendered HTML could theoretically come from elsewhere later).
const ALLOWED_POST_TAGS = new Set(['H1', 'H2', 'P', 'I', 'B', 'BR', 'DIV']);
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  (function clean(node) {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === 1) {
        if (!ALLOWED_POST_TAGS.has(child.tagName)) {
          child.replaceWith(document.createTextNode(child.textContent));
        } else {
          [...child.attributes].forEach(attr => child.removeAttribute(attr.name));
          clean(child);
        }
      } else if (child.nodeType === 8) {
        child.remove(); // strip comments
      }
    });
  })(doc.body);
  return doc.body.innerHTML.trim();
}
// For plain-text fields (titles, details) that render via innerHTML template
// strings — escapes HTML so a name/title/detail can't inject markup.
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Prevents double-firing an action (like/report/delete/follow) if a user
// taps twice quickly before the first request resolves.
const inFlight = new Set();
async function guardInFlight(key, fn) {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try { await fn(); } finally { inFlight.delete(key); }
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function initials(u) { return (u.firstName[0] + u.lastName[0]).toUpperCase(); }
function stripHtml(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------------- loading-state helpers ---------------------- */
function inlineLoadingHTML(msg = 'Loading...') {
  return `<div class="inline-loading"><span class="spinner"></span> ${msg}</div>`;
}
function skeletonPostHTML() {
  return `<div class="post">
    <div class="skeleton-header">
      <div class="skeleton-fill skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton-fill skeleton-line" style="width:35%"></div>
        <div class="skeleton-fill skeleton-line" style="width:20%;height:8px"></div>
      </div>
    </div>
    <div class="skeleton-fill skeleton-line" style="width:92%;margin-bottom:8px"></div>
    <div class="skeleton-fill skeleton-line" style="width:68%"></div>
  </div>`;
}
function skeletonPosts(n = 3) { return Array.from({ length: n }, skeletonPostHTML).join(''); }

// Disables a button, swaps its label for a spinner, and restores it afterward —
// used around any button that triggers an API call, to give feedback and stop double-submits.
async function withButtonLoading(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('is-loading');
  btn.disabled = true;
  const spinner = document.createElement('span');
  spinner.className = 'spinner light';
  btn.appendChild(spinner);
  try {
    return await fn();
  } finally {
    spinner.remove();
    btn.classList.remove('is-loading');
    btn.disabled = false;
  }
}

/* ============================= VIEW SWITCHING (auth) ============================= */
function showAuthView(id) {
  ['view-login', 'view-signup', 'view-verify', 'view-reset-request', 'view-reset-verify', 'view-onboarding']
    .forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
}
document.getElementById('link-to-signup').onclick = e => { e.preventDefault(); showAuthView('view-signup'); };
document.getElementById('link-to-login').onclick = e => { e.preventDefault(); showAuthView('view-login'); };
document.getElementById('link-to-reset').onclick = e => { e.preventDefault(); showAuthView('view-reset-request'); };
document.getElementById('link-reset-to-login').onclick = e => { e.preventDefault(); showAuthView('view-login'); };

/* ---------------------- Sign up ---------------------- */
document.getElementById('form-signup').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('signup-error');
  err.textContent = '';
  const btn = e.target.querySelector('button[type="submit"]');
  await withButtonLoading(btn, async () => {
    try {
      const body = {
        firstName: document.getElementById('signup-first').value.trim(),
        lastName: document.getElementById('signup-last').value.trim(),
        email: document.getElementById('signup-email').value.trim().toLowerCase(),
        username: document.getElementById('signup-username').value.trim(),
        password: document.getElementById('signup-password').value
      };
      if (!body.firstName || !body.lastName || !body.username) {
        err.textContent = 'Please fill in every field.'; return;
      }
      if (!EMAIL_RE.test(body.email)) {
        err.textContent = 'Please enter a valid email address.'; return;
      }
      if (!/^[a-zA-Z0-9_.]{3,20}$/.test(body.username)) {
        err.textContent = 'Username should be 3-20 characters (letters, numbers, _ or . only).'; return;
      }
      if (body.password.length < 6) {
        err.textContent = 'Password must be at least 6 characters.'; return;
      }
      const data = await api('/auth/signup', { method: 'POST', body: JSON.stringify(body) });
      pendingUserId = data.userId;
      document.getElementById('verify-email-target').textContent = body.email;
      showAuthView('view-verify');
    } catch (ex) { err.textContent = ex.message; }
  });
});

/* ---------------------- Resend verification code ---------------------- */
let resendCooldownUntil = 0;
document.getElementById('link-resend-code').addEventListener('click', async e => {
  e.preventDefault();
  const link = e.target;
  const err = document.getElementById('verify-error');
  err.textContent = '';
  if (!pendingUserId) { err.textContent = 'Please sign up or log in again first.'; return; }
  const remaining = Math.ceil((resendCooldownUntil - Date.now()) / 1000);
  if (remaining > 0) { showToast(`Please wait ${remaining}s before requesting another code.`); return; }
  try {
    link.style.pointerEvents = 'none';
    await api('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ userId: pendingUserId }) });
    showToast('A new code has been sent to your email.');
    resendCooldownUntil = Date.now() + 30000;
    let secs = 30;
    const original = link.textContent;
    const tick = setInterval(() => {
      secs--;
      link.textContent = secs > 0 ? `Resend available in ${secs}s` : original;
      if (secs <= 0) { clearInterval(tick); link.style.pointerEvents = ''; }
    }, 1000);
  } catch (ex) { err.textContent = ex.message; link.style.pointerEvents = ''; }
});

/* ---------------------- Verify email ---------------------- */
document.getElementById('form-verify').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('verify-error');
  err.textContent = '';
  const btn = e.target.querySelector('button[type="submit"]');
  await withButtonLoading(btn, async () => {
    try {
      const code = document.getElementById('verify-code').value.trim();
      const data = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ userId: pendingUserId, code }) });
      currentUser = data.user;
      pendingUserId = null;
      showToast('Email verified! Welcome to Edify Me.');
      await renderOnboarding();
      showAuthView('view-onboarding');
    } catch (ex) { err.textContent = ex.message; }
  });
});

/* ---------------------- Log in ---------------------- */
document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.textContent = '';
  const btn = e.target.querySelector('button[type="submit"]');
  const body = {
    identifier: document.getElementById('login-identifier').value.trim(),
    password: document.getElementById('login-password').value
  };
  if (!body.identifier || !body.password) { err.textContent = 'Please fill in both fields.'; return; }
  await withButtonLoading(btn, async () => {
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
      currentUser = data.user;
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      if (ex.needsVerification && ex.userId) {
        pendingUserId = ex.userId;
        document.getElementById('verify-email-target').textContent = body.identifier;
        showAuthView('view-verify');
      }
    }
  });
});

/* ---------------------- Password reset ---------------------- */
document.getElementById('form-reset-request').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('reset-request-error');
  err.textContent = '';
  const btn = e.target.querySelector('button[type="submit"]');
  await withButtonLoading(btn, async () => {
    try {
      const email = document.getElementById('reset-email').value.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) { err.textContent = 'Please enter a valid email address.'; return; }
      const data = await api('/auth/reset/request', { method: 'POST', body: JSON.stringify({ email }) });
      pendingResetUserId = data.userId;
      showAuthView('view-reset-verify');
    } catch (ex) { err.textContent = ex.message; }
  });
});
document.getElementById('form-reset-verify').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('reset-verify-error');
  err.textContent = '';
  const btn = e.target.querySelector('button[type="submit"]');
  await withButtonLoading(btn, async () => {
    try {
      const code = document.getElementById('reset-code').value.trim();
      const newPassword = document.getElementById('reset-new-password').value;
      if (newPassword.length < 6) { err.textContent = 'New password must be at least 6 characters.'; return; }
      await api('/auth/reset/verify', { method: 'POST', body: JSON.stringify({ userId: pendingResetUserId, code, newPassword }) });
      pendingResetUserId = null;
      showToast('Password reset! Please log in.');
      showAuthView('view-login');
    } catch (ex) { err.textContent = ex.message; }
  });
});

/* ---------------------- Onboarding (new users) ---------------------- */
async function renderOnboarding() {
  const box = document.getElementById('onboarding-suggestions');
  box.innerHTML = inlineLoadingHTML('Finding people for you...');
  try {
    const suggestions = await api('/users/suggestions/list');
    box.innerHTML = '';
    suggestions.forEach(u => box.appendChild(buildSuggestionRow(u)));
  } catch (ex) { box.innerHTML = `<p class="muted">${ex.message}</p>`; }
}
document.getElementById('onboarding-continue').addEventListener('click', enterApp);

/* ============================= SESSION CHECK ON LOAD ============================= */
// Since the session lives in an httpOnly cookie, we just ask the server
// "who am I?" on page load — if the cookie is valid we skip straight to the app.
(async function checkSession() {
  try {
    currentUser = await api('/users/me');
    await enterApp();
  } catch (_) {
    document.getElementById('auth-wrap').classList.remove('hidden');
    showAuthView('view-login');
  } finally {
    document.getElementById('initial-loader').classList.add('hidden');
  }
})();

/* ============================= APP ENTRY ============================= */
async function enterApp() {
  document.getElementById('auth-wrap').classList.add('hidden');
  document.getElementById('app-wrap').classList.remove('hidden');
  document.getElementById('topbar-username').textContent = '@' + currentUser.username;
  await goToPage('feeds');
}
document.getElementById('btn-logout').addEventListener('click', async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch (_) {}
  currentUser = null;
  document.getElementById('app-wrap').classList.add('hidden');
  document.getElementById('auth-wrap').classList.remove('hidden');
  showAuthView('view-login');
  document.getElementById('form-login').reset();
});

/* ============================= NAVIGATION ============================= */
document.getElementById('navbar').addEventListener('click', e => {
  const btn = e.target.closest('.nav-btn');
  if (!btn) return;
  goToPage(btn.dataset.page);
});
async function goToPage(page) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-' + page).classList.remove('hidden');
  if (page === 'feeds') await renderFeedPage();
  if (page === 'followers') await renderFollowersPage();
  if (page === 'profile') await renderProfilePage();
  if (page === 'announcements') await renderAnnouncementsPage();
  if (page === 'settings') renderSettingsPage();
}
async function refreshCurrentPage() {
  const active = document.querySelector('.nav-btn.active');
  if (active) await goToPage(active.dataset.page);
}

/* ============================= COMPOSER ============================= */
document.querySelectorAll('.fmt-btn[data-format]').forEach(btn => {
  btn.addEventListener('click', () => {
    const fmt = btn.dataset.format;
    document.getElementById('composer-text').focus();
    if (fmt === 'italic') document.execCommand('italic');
    else document.execCommand('formatBlock', false, fmt);
  });
});
document.getElementById('composer-edit-toggle').addEventListener('click', () => {
  const box = document.getElementById('composer-text');
  const editable = box.getAttribute('contenteditable') === 'true';
  box.setAttribute('contenteditable', editable ? 'false' : 'true');
  showToast(editable ? 'Text locked' : 'Text unlocked for editing');
});
document.getElementById('composer-image').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  composerImage = await fileToDataURL(file);
  document.getElementById('composer-media-preview').innerHTML = `<img src="${composerImage}" alt="preview"> image attached`;
});
document.getElementById('composer-music').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    showToast('For this demo, keep audio under 4MB. (Production apps should upload to real file storage, e.g. Cloudinary/S3, instead of embedding audio in the database.)');
    e.target.value = '';
    return;
  }
  composerMusic = await fileToDataURL(file);
  document.getElementById('composer-media-preview').innerHTML += ` 🎵 ${file.name} attached`;
});
document.getElementById('composer-clear').addEventListener('click', () => {
  document.getElementById('composer-text').innerHTML = '';
  composerImage = null; composerMusic = null;
  document.getElementById('composer-media-preview').innerHTML = '';
  document.getElementById('composer-image').value = '';
  document.getElementById('composer-music').value = '';
});
document.getElementById('composer-post').addEventListener('click', async e => {
  const box = document.getElementById('composer-text');
  const html = sanitizeHtml(box.innerHTML.trim());
  if (!html && !composerImage) { showToast('Write something or add an image first.'); return; }
  if (html.length > 5000) { showToast('That post is too long — please shorten it.'); return; }
  await withButtonLoading(e.currentTarget, async () => {
    try {
      await api('/posts', { method: 'POST', body: JSON.stringify({ html, imageUrl: composerImage, musicUrl: composerMusic }) });
      box.innerHTML = ''; composerImage = null; composerMusic = null;
      document.getElementById('composer-media-preview').innerHTML = '';
      document.getElementById('composer-image').value = '';
      document.getElementById('composer-music').value = '';
      showToast('Posted!');
      await renderFeedPage();
    } catch (ex) { showToast(ex.message); }
  });
});

/* ============================= FEED PAGE ============================= */
async function renderFeedPage() {
  const list = document.getElementById('feed-list');
  list.innerHTML = skeletonPosts(3);
  try {
    const [posts, people, suggestedPosts] = await Promise.all([
      api('/posts/feed'),
      api('/users/suggestions/list'),
      api('/posts/suggested')
    ]);

    list.innerHTML = posts.length ? '' : '<p class="muted">No posts yet.</p>';
    posts.forEach(p => list.appendChild(buildPostCard(p)));

    const peopleBox = document.getElementById('suggested-people');
    peopleBox.innerHTML = '';
    people.slice(0, 3).forEach(u => peopleBox.appendChild(buildSuggestionRow(u)));

    const postsBox = document.getElementById('suggested-posts');
    postsBox.innerHTML = '';
    suggestedPosts.forEach(p => {
      const row = document.createElement('div');
      row.className = 'suggestion-item';
      row.innerHTML = `<div class="avatar">${initials(p.author)}</div>
        <div class="s-info"><div class="s-name">@${p.author.username}</div>
        <div class="s-meta">${stripHtml(p.html).slice(0, 50)}...</div></div>`;
      postsBox.appendChild(row);
    });
  } catch (ex) { list.innerHTML = `<p class="muted">${ex.message}</p>`; }
}

function buildPostCard(post) {
  const author = post.author;
  const isOwn = author.id === currentUser.id;
  const isFollowing = (currentUser.followingIds || []).includes(author.id);

  const el = document.createElement('div');
  el.className = 'post';
  el.innerHTML = `
    <div class="post-header">
      <div class="avatar">${escapeHtml(initials(author))}</div>
      <div>
        <div class="p-name">${escapeHtml(author.firstName)} ${escapeHtml(author.lastName)} <span class="p-meta">@${escapeHtml(author.username)}</span>
          ${isFollowing ? '<span class="badge">Following</span>' : ''}</div>
        <div class="p-meta">${timeAgo(post.createdAt)}</div>
      </div>
      <div class="post-follow-slot">
        ${!isOwn ? followButtonHTML(author) : '<button class="icon-btn btn-delete" title="Delete post">🗑️ Delete</button>'}
      </div>
    </div>
    <div class="post-body">${sanitizeHtml(post.html)}</div>
    ${post.imageUrl ? `<img class="post-image" src="${escapeHtml(post.imageUrl)}">` : ''}
    ${post.musicUrl ? `<audio class="post-audio" controls src="${escapeHtml(post.musicUrl)}"></audio>` : ''}
    ${post.reportCount > 0 ? `<div class="reported-flag">⚑ Reported ${post.reportCount} time(s)</div>` : ''}
    <div class="post-footer">
      <button class="icon-btn btn-like ${post.likedByMe ? 'liked' : ''}">❤ <span>${post.likeCount}</span></button>
      <button class="icon-btn btn-report ${post.reportedByMe ? 'reported' : ''}">⚑ ${post.reportedByMe ? 'Reported' : 'Report'}</button>
      <div class="spacer"></div>
    </div>
  `;
  el.querySelector('.btn-like').addEventListener('click', () => guardInFlight(`like-${post.id}`, () => toggleLike(post.id)));
  el.querySelector('.btn-report').addEventListener('click', () => guardInFlight(`report-${post.id}`, () => reportPost(post.id)));
  const followBtn = el.querySelector('.btn-follow-toggle');
  if (followBtn) followBtn.addEventListener('click', () => guardInFlight(`follow-${author.id}`, () => toggleFollow(author.id, author.username)));
  const delBtn = el.querySelector('.btn-delete');
  if (delBtn) delBtn.addEventListener('click', () => guardInFlight(`delete-${post.id}`, () => deletePost(post.id)));
  return el;
}
function followButtonHTML(targetUser) {
  const isFollowing = (currentUser.followingIds || []).includes(targetUser.id);
  return `<button class="btn btn-small ${isFollowing ? 'btn-following' : 'btn-follow'} btn-follow-toggle">
    ${isFollowing ? 'Following' : 'Follow'}</button>`;
}

/* ============================= LIKE / REPORT / DELETE ============================= */
async function toggleLike(postId) {
  try { await api(`/posts/${postId}/like`, { method: 'POST' }); await refreshCurrentPage(); }
  catch (ex) { showToast(ex.message); }
}
async function reportPost(postId) {
  const reason = prompt('Why are you reporting this post? (e.g. content not related to Christianity, offensive, spam)');
  if (reason === null) return;
  try {
    await api(`/posts/${postId}/report`, { method: 'POST', body: JSON.stringify({ reason: reason || 'unspecified' }) });
    showToast('Thanks — our team will review this post.');
    await refreshCurrentPage();
  } catch (ex) { showToast(ex.message); }
}
async function deletePost(postId) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try { await api(`/posts/${postId}`, { method: 'DELETE' }); showToast('Post deleted.'); await refreshCurrentPage(); }
  catch (ex) { showToast(ex.message); }
}

/* ============================= FOLLOW / UNFOLLOW ============================= */
async function toggleFollow(targetId, targetUsername) {
  const alreadyFollowing = (currentUser.followingIds || []).includes(targetId);
  try {
    if (!alreadyFollowing) {
      await api(`/users/${targetId}/follow`, { method: 'POST' });
      showToast('Now following @' + targetUsername);
    } else {
      const ok = confirm(`Unfollow @${targetUsername}? You'll stop seeing their posts in your following feed.`);
      if (!ok) return;
      await api(`/users/${targetId}/follow`, { method: 'DELETE' });
      showToast('Unfollowed @' + targetUsername);
    }
    currentUser = await api('/users/me'); // refresh followingIds
    await refreshCurrentPage();
  } catch (ex) { showToast(ex.message); }
}
function buildSuggestionRow(u) {
  const row = document.createElement('div');
  row.className = 'suggestion-item';
  row.innerHTML = `<div class="avatar">${escapeHtml(initials(u))}</div>
    <div class="s-info"><div class="s-name">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</div>
    <div class="s-meta">@${escapeHtml(u.username)} · ${u.followersCount} followers</div></div>`;
  const btn = document.createElement('button');
  const isFollowing = (currentUser.followingIds || []).includes(u.id);
  btn.className = 'btn btn-small ' + (isFollowing ? 'btn-following' : 'btn-follow');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.addEventListener('click', () => guardInFlight(`follow-${u.id}`, () => toggleFollow(u.id, u.username)));
  row.appendChild(btn);
  return row;
}

/* ============================= FOLLOWERS PAGE ============================= */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('hidden');
  });
});
async function renderFollowersPage() {
  const followingPanel = document.getElementById('tab-following');
  const followersPanel = document.getElementById('tab-followers-of-me');
  const discoverPanel = document.getElementById('tab-discover');
  followingPanel.innerHTML = followersPanel.innerHTML = discoverPanel.innerHTML = inlineLoadingHTML();

  try {
    const [following, followers, discover] = await Promise.all([
      api('/users/me/following'),
      api('/users/me/followers'),
      api('/users/suggestions/list')
    ]);
    followingPanel.innerHTML = following.length ? '' : '<p class="muted">You aren\'t following anyone yet.</p>';
    following.forEach(u => followingPanel.appendChild(buildPersonRow(u)));

    followersPanel.innerHTML = followers.length ? '' : '<p class="muted">No followers yet.</p>';
    followers.forEach(u => followersPanel.appendChild(buildPersonRow(u)));

    discoverPanel.innerHTML = discover.length ? '' : '<p class="muted">No suggestions right now.</p>';
    discover.forEach(u => discoverPanel.appendChild(buildPersonRow(u)));
  } catch (ex) { followingPanel.innerHTML = `<p class="muted">${ex.message}</p>`; }
}
function buildPersonRow(u) {
  const row = document.createElement('div');
  row.className = 'person-row';
  row.innerHTML = `<div class="avatar">${escapeHtml(initials(u))}</div>
    <div class="p-info"><div class="p-name">${escapeHtml(u.firstName)} ${escapeHtml(u.lastName)}</div>
    <div class="p-sub">@${escapeHtml(u.username)} · ${u.followersCount} followers · ${u.followingCount} following</div></div>`;
  const btn = document.createElement('button');
  const isFollowing = (currentUser.followingIds || []).includes(u.id);
  btn.className = 'btn btn-small ' + (isFollowing ? 'btn-following' : 'btn-follow');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.addEventListener('click', () => guardInFlight(`follow-${u.id}`, async () => { await toggleFollow(u.id, u.username); await renderFollowersPage(); }));
  row.appendChild(btn);
  return row;
}

/* ============================= PROFILE PAGE ============================= */
async function renderProfilePage() {
  document.getElementById('profile-avatar').textContent = initials(currentUser);
  document.getElementById('profile-name').textContent = currentUser.firstName + ' ' + currentUser.lastName;
  document.getElementById('profile-username').textContent = '@' + currentUser.username;
  document.getElementById('profile-following-count').textContent = currentUser.followingCount ?? 0;
  document.getElementById('profile-followers-count').textContent = currentUser.followersCount ?? 0;

  const list = document.getElementById('profile-posts');
  list.innerHTML = skeletonPosts(2);
  try {
    const myPosts = await api('/posts/mine');
    document.getElementById('profile-posts-count').textContent = myPosts.length;
    list.innerHTML = myPosts.length ? '' : '<p class="muted">You haven\'t posted anything yet.</p>';
    myPosts.forEach(p => list.appendChild(buildPostCard(p)));
  } catch (ex) { list.innerHTML = `<p class="muted">${ex.message}</p>`; }
}

/* ============================= ANNOUNCEMENTS PAGE ============================= */
document.getElementById('ann-image').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  annImage = await fileToDataURL(file);
  document.getElementById('ann-media-preview').innerHTML = `<img src="${annImage}" alt="preview"> flier attached`;
});
document.getElementById('ann-post').addEventListener('click', async e => {
  const title = document.getElementById('ann-title').value.trim();
  const html = document.getElementById('ann-details').value.trim();
  if (!title || !html) { showToast('Add a title and details for your program.'); return; }
  if (title.length > 120) { showToast('Title is too long — please shorten it.'); return; }
  if (html.length > 3000) { showToast('Details are too long — please shorten them.'); return; }
  await withButtonLoading(e.currentTarget, async () => {
    try {
      await api('/posts/announcements', { method: 'POST', body: JSON.stringify({ title, html, imageUrl: annImage }) });
      document.getElementById('ann-title').value = '';
      document.getElementById('ann-details').value = '';
      document.getElementById('ann-media-preview').innerHTML = '';
      document.getElementById('ann-image').value = '';
      annImage = null;
      showToast('Announcement posted!');
      await renderAnnouncementsPage();
    } catch (ex) { showToast(ex.message); }
  });
});
async function renderAnnouncementsPage() {
  const list = document.getElementById('announcements-list');
  list.innerHTML = skeletonPosts(2);
  try {
    const items = await api('/posts/announcements/list');
    list.innerHTML = items.length ? '' : '<p class="muted">No program announcements yet.</p>';
    items.forEach(a => {
      const author = a.author;
      const isOwn = author.id === currentUser.id;
      const el = document.createElement('div');
      el.className = 'post';
      el.innerHTML = `
        <div class="post-header">
          <div class="avatar">${escapeHtml(initials(author))}</div>
          <div><div class="p-name">${escapeHtml(author.firstName)} ${escapeHtml(author.lastName)} <span class="p-meta">@${escapeHtml(author.username)}</span>
            <span class="badge">Program</span></div>
            <div class="p-meta">${timeAgo(a.createdAt)}</div></div>
          <div class="post-follow-slot">
            ${!isOwn ? followButtonHTML(author) : '<button class="icon-btn btn-delete">🗑️ Delete</button>'}
          </div>
        </div>
        <div class="post-body"><h2>${escapeHtml(a.title)}</h2><p>${escapeHtml(a.html)}</p></div>
        ${a.imageUrl ? `<img class="post-image" src="${escapeHtml(a.imageUrl)}">` : ''}
        ${a.reportCount > 0 ? `<div class="reported-flag">⚑ Reported ${a.reportCount} time(s)</div>` : ''}
        <div class="post-footer">
          <button class="icon-btn btn-like ${a.likedByMe ? 'liked' : ''}">❤ <span>${a.likeCount}</span></button>
          <button class="icon-btn btn-report ${a.reportedByMe ? 'reported' : ''}">⚑ ${a.reportedByMe ? 'Reported' : 'Report'}</button>
        </div>`;
      el.querySelector('.btn-like').addEventListener('click', () => guardInFlight(`like-${a.id}`, () => toggleLike(a.id)));
      el.querySelector('.btn-report').addEventListener('click', () => guardInFlight(`report-${a.id}`, () => reportPost(a.id)));
      const fb = el.querySelector('.btn-follow-toggle'); if (fb) fb.addEventListener('click', () => guardInFlight(`follow-${author.id}`, () => toggleFollow(author.id, author.username)));
      const db = el.querySelector('.btn-delete'); if (db) db.addEventListener('click', () => guardInFlight(`delete-${a.id}`, () => deletePost(a.id)));
      list.appendChild(el);
    });
  } catch (ex) { list.innerHTML = `<p class="muted">${ex.message}</p>`; }
}

/* ============================= SETTINGS PAGE ============================= */
function renderSettingsPage() {
  document.getElementById('settings-first').value = currentUser.firstName;
  document.getElementById('settings-last').value = currentUser.lastName;
  document.getElementById('settings-email').value = currentUser.email;
  document.getElementById('settings-pw-error').textContent = '';
}
document.getElementById('settings-save').addEventListener('click', async e => {
  await withButtonLoading(e.currentTarget, async () => {
    try {
      const firstName = document.getElementById('settings-first').value.trim();
      const lastName = document.getElementById('settings-last').value.trim();
      currentUser = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ firstName, lastName }) });
      showToast('Profile updated.');
    } catch (ex) { showToast(ex.message); }
  });
});
document.getElementById('settings-change-pw').addEventListener('click', async e => {
  const err = document.getElementById('settings-pw-error');
  err.textContent = '';
  await withButtonLoading(e.currentTarget, async () => {
    try {
      const currentPassword = document.getElementById('settings-current-pw').value;
      const newPassword = document.getElementById('settings-new-pw').value;
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      document.getElementById('settings-current-pw').value = '';
      document.getElementById('settings-new-pw').value = '';
      showToast('Password updated.');
    } catch (ex) { err.textContent = ex.message; }
  });
});
