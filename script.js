/* =====================================================================
   EDIFY ME — frontend, talking to a REAL backend (Express + Postgres via
   Prisma + Resend for email). No data is stored in the browser: your
   login session lives in an httpOnly cookie the server sets, so nothing
   here uses localStorage/sessionStorage. If the API isn't reachable
   (server not running, wrong URL, CORS), calls below will show an error
   toast — start the backend with `npm run dev` first.
   ===================================================================== */

const API = 'http://localhost:4000/api';

let currentUser = null;      // full user object from GET /users/me, refreshed after actions
let pendingUserId = null;    // user awaiting email verification (signup or unverified login)
let pendingResetUserId = null;
let composerImage = null;    // base64 data URL
let composerMusic = null;    // base64 data URL
let annImage = null;

/* ---------------------- API helper ---------------------- */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    credentials: 'include', // sends/receives the httpOnly session cookie
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------------- small utilities ---------------------- */
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
        email: document.getElementById('signup-email').value.trim(),
        username: document.getElementById('signup-username').value.trim(),
        password: document.getElementById('signup-password').value
      };
      const data = await api('/auth/signup', { method: 'POST', body: JSON.stringify(body) });
      pendingUserId = data.userId;
      document.getElementById('verify-email-target').textContent = body.email;
      showAuthView('view-verify');
    } catch (ex) { err.textContent = ex.message; }
  });
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
  await withButtonLoading(btn, async () => {
    try {
      const body = {
        identifier: document.getElementById('login-identifier').value.trim(),
        password: document.getElementById('login-password').value
      };
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
      currentUser = data.user;
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      if (ex.message.toLowerCase().includes('verify')) showAuthView('view-verify');
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
      const email = document.getElementById('reset-email').value.trim();
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
  const html = box.innerHTML.trim();
  if (!html && !composerImage) { showToast('Write something or add an image first.'); return; }
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
      <div class="avatar">${initials(author)}</div>
      <div>
        <div class="p-name">${author.firstName} ${author.lastName} <span class="p-meta">@${author.username}</span>
          ${isFollowing ? '<span class="badge">Following</span>' : ''}</div>
        <div class="p-meta">${timeAgo(post.createdAt)}</div>
      </div>
      <div class="post-follow-slot">
        ${!isOwn ? followButtonHTML(author) : '<button class="icon-btn btn-delete" title="Delete post">🗑️ Delete</button>'}
      </div>
    </div>
    <div class="post-body">${post.html}</div>
    ${post.imageUrl ? `<img class="post-image" src="${post.imageUrl}">` : ''}
    ${post.musicUrl ? `<audio class="post-audio" controls src="${post.musicUrl}"></audio>` : ''}
    ${post.reportCount > 0 ? `<div class="reported-flag">⚑ Reported ${post.reportCount} time(s)</div>` : ''}
    <div class="post-footer">
      <button class="icon-btn btn-like ${post.likedByMe ? 'liked' : ''}">❤ <span>${post.likeCount}</span></button>
      <button class="icon-btn btn-report ${post.reportedByMe ? 'reported' : ''}">⚑ ${post.reportedByMe ? 'Reported' : 'Report'}</button>
      <div class="spacer"></div>
    </div>
  `;
  el.querySelector('.btn-like').addEventListener('click', () => toggleLike(post.id));
  el.querySelector('.btn-report').addEventListener('click', () => reportPost(post.id));
  const followBtn = el.querySelector('.btn-follow-toggle');
  if (followBtn) followBtn.addEventListener('click', () => toggleFollow(author.id, author.username));
  const delBtn = el.querySelector('.btn-delete');
  if (delBtn) delBtn.addEventListener('click', () => deletePost(post.id));
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
  row.innerHTML = `<div class="avatar">${initials(u)}</div>
    <div class="s-info"><div class="s-name">${u.firstName} ${u.lastName}</div>
    <div class="s-meta">@${u.username} · ${u.followersCount} followers</div></div>`;
  const btn = document.createElement('button');
  const isFollowing = (currentUser.followingIds || []).includes(u.id);
  btn.className = 'btn btn-small ' + (isFollowing ? 'btn-following' : 'btn-follow');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.addEventListener('click', async () => { await toggleFollow(u.id, u.username); });
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
  row.innerHTML = `<div class="avatar">${initials(u)}</div>
    <div class="p-info"><div class="p-name">${u.firstName} ${u.lastName}</div>
    <div class="p-sub">@${u.username} · ${u.followersCount} followers · ${u.followingCount} following</div></div>`;
  const btn = document.createElement('button');
  const isFollowing = (currentUser.followingIds || []).includes(u.id);
  btn.className = 'btn btn-small ' + (isFollowing ? 'btn-following' : 'btn-follow');
  btn.textContent = isFollowing ? 'Following' : 'Follow';
  btn.addEventListener('click', async () => { await toggleFollow(u.id, u.username); await renderFollowersPage(); });
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
          <div class="avatar">${initials(author)}</div>
          <div><div class="p-name">${author.firstName} ${author.lastName} <span class="p-meta">@${author.username}</span>
            <span class="badge">Program</span></div>
            <div class="p-meta">${timeAgo(a.createdAt)}</div></div>
          <div class="post-follow-slot">
            ${!isOwn ? followButtonHTML(author) : '<button class="icon-btn btn-delete">🗑️ Delete</button>'}
          </div>
        </div>
        <div class="post-body"><h2>${a.title}</h2><p>${a.html}</p></div>
        ${a.imageUrl ? `<img class="post-image" src="${a.imageUrl}">` : ''}
        ${a.reportCount > 0 ? `<div class="reported-flag">⚑ Reported ${a.reportCount} time(s)</div>` : ''}
        <div class="post-footer">
          <button class="icon-btn btn-like ${a.likedByMe ? 'liked' : ''}">❤ <span>${a.likeCount}</span></button>
          <button class="icon-btn btn-report ${a.reportedByMe ? 'reported' : ''}">⚑ ${a.reportedByMe ? 'Reported' : 'Report'}</button>
        </div>`;
      el.querySelector('.btn-like').addEventListener('click', () => toggleLike(a.id));
      el.querySelector('.btn-report').addEventListener('click', () => reportPost(a.id));
      const fb = el.querySelector('.btn-follow-toggle'); if (fb) fb.addEventListener('click', () => toggleFollow(author.id, author.username));
      const db = el.querySelector('.btn-delete'); if (db) db.addEventListener('click', () => deletePost(a.id));
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
