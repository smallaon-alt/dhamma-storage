import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { TYPES, ROLE_LABEL, esc, thaiDate, store, shrinkImage, isPdf } from './util.js';
import { buildIndex, search, excerptHtml, markTerms, norm, autoTitle, suggestTags } from './search.js';

const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY;
const app = document.getElementById('app');
const tc = (type) => `--tc:var(--c-${type})`;

const S = {
  api: null, user: null, profile: null,
  stories: [], tags: [], index: [],
  // ตัวกรองแบบแอปคลังเทศน์
  f: {
    q: '', off: new Set(store.get('yom-off', [])), tags: new Set(), who: new Set(),
    tagQ: '', whoQ: '', tagAll: false, whoAll: false,
    syn: store.get('yom-syn', true), draftsOnly: false, mfOpen: false,
    mine: 'all',   // all | unread | reading | new | fav
  },
  me: { reads: {}, fav: new Set() },   // การอ่านของฉัน: ล็อกอิน = Supabase, ไม่ล็อกอิน = เบราว์เซอร์นี้
  people: {},                          // id → ชื่อ (ทีมงานเท่านั้นที่โหลดได้)
  view: '', lastHash: '#/', dirty: false, inApp: 0,
  stack: [], stackFromApp: false,   // ประวัติการเปิดอ่านในหน้าต่างอ่าน
  ed: null,
};

const role = () => S.profile?.role || 'guest';
const isEditor = () => role() === 'editor' || role() === 'admin';
const isAdmin = () => role() === 'admin';

// ===================================================================== เริ่มต้น
async function boot() {
  try {
    S.api = isDemo
      ? (await import('./backend-demo.js')).default
      : (await import('./backend-supabase.js')).create(SUPABASE_URL, SUPABASE_ANON_KEY);
    S.api.onAuthChange(async () => { await refresh(); S.view = ''; route(); });
    await refresh();
  } catch (err) {
    app.innerHTML = `<div class="wrap"><div class="empty"><strong>เปิดคลังไม่ได้</strong>${esc(err.message)}<br>ตรวจการเชื่อมต่ออินเทอร์เน็ต แล้วโหลดหน้านี้ใหม่</div></div>`;
    return;
  }
  setRead(store.get('yom-fs', 19));
  window.addEventListener('hashchange', onHash);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.drawer')) actions.close(); });
  route();
}

async function refresh() {
  const { user, profile } = await S.api.session();
  S.user = user;
  S.profile = profile;
  [S.stories, S.tags] = await Promise.all([S.api.listStories(), S.api.listTags()]);
  S.index = buildIndex(S.stories);
  S.bookCols = S.stories.some((x) => 'book' in x);   // ฐานข้อมูลรัน 002_books.sql แล้วหรือยัง
  await loadMe();
  S.people = {};
  if (isEditor()) {
    try { for (const p of await S.api.listProfiles()) S.people[p.id] = p.display_name || p.email; } catch { /* ไม่มีชื่อก็ยังใช้งานได้ */ }
  }
}

// ===================================================================== การอ่านของฉัน (อ่านแล้ว / อ่านถึงไหน / ที่ชอบ)
const NEW_DAYS = 30;
const LOCAL_ME = 'yom-me';
const isQuote = (s) => s.type === 'คำคม';

async function loadMe() {
  const local = store.get(LOCAL_ME, { reads: {}, bookmarks: [] });
  if (!S.user) {
    S.me = { reads: local.reads, fav: new Set(local.bookmarks) };
    return;
  }
  let mine = { reads: {}, bookmarks: [] };
  try { mine = await S.api.listMine(); } catch (err) { console.warn(err); }
  S.me = { reads: mine.reads, fav: new Set(mine.bookmarks) };
  // อ่านไว้ก่อนล็อกอิน: รวมเข้าบัญชีแล้วล้างของในเครื่อง
  const ids = new Set(S.stories.map((x) => x.id));
  const jobs = [];
  for (const [id, r] of Object.entries(local.reads)) {
    if (!ids.has(id)) continue;
    const cur = S.me.reads[id];
    const merged = { position: Math.max(r.position || 0, cur?.position || 0), read_at: cur?.read_at || r.read_at || null };
    if (!cur || merged.position !== cur.position || merged.read_at !== cur.read_at) {
      S.me.reads[id] = merged;
      jobs.push(S.api.putRead(id, merged));
    }
  }
  for (const id of local.bookmarks) {
    if (ids.has(id) && !S.me.fav.has(id)) { S.me.fav.add(id); jobs.push(S.api.setBookmark(id, true)); }
  }
  if (jobs.length) {
    try { await Promise.all(jobs); store.set(LOCAL_ME, { reads: {}, bookmarks: [] }); } catch (err) { console.warn(err); }
  } else if (Object.keys(local.reads).length || local.bookmarks.length) store.set(LOCAL_ME, { reads: {}, bookmarks: [] });
}

function saveLocalMe() {
  if (!S.user) store.set(LOCAL_ME, { reads: S.me.reads, bookmarks: [...S.me.fav] });
}

function putRead(id, patch) {
  const cur = S.me.reads[id] || { position: 0, read_at: null };
  const next = { ...cur, ...patch };
  if (cur.position === next.position && cur.read_at === next.read_at && S.me.reads[id]) return;
  S.me.reads[id] = next;
  if (S.user) S.api.putRead(id, next).catch((err) => toast(err.message, true));
  else saveLocalMe();
}

// ===================================================================== หนังสือ (แต่ละบท = 1 เรื่องที่มีชื่อเล่มกำกับ)
const bookOf = (s) => (s.type === 'หนังสือ' && s.book ? s.book : null);
const byOrder = (a, b) => (a.book_order ?? 1e9) - (b.book_order ?? 1e9) || (a.created_at || '').localeCompare(b.created_at || '');
const chapters = (name) => S.stories.filter((x) => bookOf(x) === name).sort(byOrder);
const bookNames = () => [...new Set(S.stories.map(bookOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
const bookHref = (name) => `#/b/${encodeURIComponent(name)}`;
const nextOrder = (name) => Math.max(0, ...chapters(name).map((x) => x.book_order || 0)) + 1;

const readInfo = (s) => S.me.reads[s.id] || null;
const isRead = (s) => !isQuote(s) && !!readInfo(s)?.read_at;
const isNew = (s) => !readInfo(s) && Date.now() - new Date(s.created_at).getTime() < NEW_DAYS * 864e5;
const inProgress = (s) => !isQuote(s) && !isRead(s) && (readInfo(s)?.position || 0) >= 3;

function onHash() {
  if (S.skipHash) { S.skipHash = false; return; }
  if (S.dirty && !confirm('ทิ้งการแก้ไขที่ยังไม่ได้บันทึก?')) {
    S.skipHash = true;
    location.hash = S.lastHash;
    return;
  }
  S.dirty = false;
  S.inApp++;
  route();
}

function route() {
  const raw = location.hash.slice(1) || '/';
  S.lastHash = location.hash || '#/';
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const guard = (ok, fn) => (ok() ? fn() : viewDenied());
  if (parts[0] !== 's' && parts[0] !== 'b') closeDrawer();

  switch (parts[0]) {
    case undefined:
      if (qs) applyQuery(qs);
      if (S.view === 'search' && !qs) return;          // ปิดหน้าต่างอ่าน กลับมาที่เดิม
      return viewSearch();
    case 's':
      if (S.view !== 'search') viewSearch();
      return openDrawer(parts[1]);
    case 'b':
      if (S.view !== 'search') viewSearch();
      return openBook(parts[1]);
    case 'new': return guard(isEditor, () => viewEditor(null, new URLSearchParams(qs || '')));
    case 'edit': return guard(isEditor, () => viewEditor(parts[1]));
    case 'tags': return guard(isEditor, viewTags);
    case 'trash': return guard(isEditor, viewTrash);
    case 'users': return guard(isAdmin, viewUsers);
    default: location.hash = '#/';
  }
}

// ลิงก์ #/?tag=… หรือ #/?who=… = ดูเรื่องทั้งหมดของแท็ก/ผู้กล่าวนั้น
function applyQuery(qs) {
  const p = new URLSearchParams(qs);
  S.f.q = '';
  S.f.tags = new Set(p.getAll('tag'));
  S.f.who = new Set(p.getAll('who'));
  setOff(new Set());
  S.view = '';
}

// ===================================================================== โครงหน้า
const ICON = {
  search: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  tag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  users: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2"/></svg>',
  book: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/></svg>',
  clip: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="มีไฟล์ต้นฉบับ"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7"/></svg>',
};

const LOTUS = `<svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M16 4c3.4 4.2 4.4 8.6 0 16-4.4-7.4-3.4-11.8 0-16z" fill="#E0457B"/>
  <path d="M16 20c-4-5.2-8.2-7.2-13-7.2 1 6.4 6 9.6 13 7.2zM16 20c4-5.2 8.2-7.2 13-7.2-1 6.4-6 9.6-13 7.2z" fill="#F08A00"/>
  <path d="M5 25h22" stroke="#13906A" stroke-width="2.6" stroke-linecap="round"/></svg>`;

function shell(main, current = '') {
  const staff = isEditor();
  document.body.classList.toggle('staff', staff);
  const tab = (href, label, icon) =>
    `<a href="${href}" ${current === href ? 'aria-current="page"' : ''}><span class="ic">${ICON[icon]}</span>${label}</a>`;
  const tabs = staff ? `<nav class="tabs staff" aria-label="เมนูทีมงาน">
      ${tab('#/', 'ค้นหา', 'search')}${tab('#/new', 'เพิ่มข้อมูล', 'plus')}${tab('#/tags', 'แท็ก', 'tag')}${tab('#/trash', 'ถังขยะ', 'trash')}${isAdmin() ? tab('#/users', 'ผู้ใช้', 'users') : ''}
    </nav>` : '';
  const auth = S.user
    ? `<span class="who" title="${esc(ROLE_LABEL[role()] || '')}">${esc(S.profile?.display_name || '')}</span><button class="btn small" data-act="logout">ออกจากระบบ</button>`
    : `<button class="btn small ink" data-act="login">เข้าสู่ระบบ</button>`;
  const demo = isDemo ? `
    <div class="demo-bar">
      <span>โหมดทดลอง: ข้อมูลตัวอย่างเก็บในเบราว์เซอร์นี้เท่านั้น</span>
      <label>ดูในฐานะ
        <select data-change="demo-role">
          ${[['guest', 'ยังไม่ล็อกอิน'], ['reader', 'โยม'], ['editor', 'ผู้ดูแลเนื้อหา'], ['admin', 'แอดมิน']]
            .map(([v, l]) => `<option value="${v}" ${role() === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <button data-act="demo-reset">ล้างข้อมูลทดลอง</button>
    </div>` : '';

  return `${demo}
    <header class="top"><div class="wrap top-row">
      <a class="brand" href="#/" aria-label="คลังธรรมะ หน้าค้นหา">${LOTUS}<span>คลังธรรมะ</span></a>
      ${tabs}<span class="spacer"></span><div class="auth">${auth}</div>
    </div></header>
    <main><div class="wrap">${main}</div></main>`;
}

function viewDenied() {
  S.view = 'denied';
  app.innerHTML = shell(`<div class="empty"><strong>หน้านี้สำหรับทีมงาน</strong>
    ${S.user ? 'บัญชีนี้ยังไม่มีสิทธิ์ ให้แอดมินตั้งบทบาทให้ก่อน' : 'เข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์ก่อน'}
    <p><a class="btn" href="#/">กลับไปหน้าค้นหา</a></p></div>`);
}

// ===================================================================== หน้าค้นหา (ตามแท็บค้นหาของแอป)
function viewSearch() {
  S.view = 'search';
  const f = S.f;
  app.innerHTML = shell(`
    <div class="searchbar">
      <span class="ic-search">${ICON.search}</span>
      <label class="sr-only" for="q">ค้นเรื่อง</label>
      <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="ค้นเรื่อง" value="${esc(f.q)}">
      <button class="btn small" data-act="random">สุ่มเรื่อง</button>
    </div>
    <div class="filters">
      <div class="seg typesel" id="typesel" role="group" aria-label="ประเภทเรื่อง"></div>
      <div class="seg mine" id="minesel" role="group" aria-label="สถานะการอ่าน"></div>
      <label class="toggle"><input type="checkbox" data-change="syn" ${f.syn ? 'checked' : ''}> ค้นคำใกล้เคียงด้วย</label>
      ${isEditor() ? `<label class="toggle"><input type="checkbox" data-change="drafts" ${f.draftsOnly ? 'checked' : ''}> เฉพาะร่าง</label>` : ''}
      <span class="seg-hint">แตะประเภทเพื่อซ่อน/แสดง · แตะค้าง = ดูประเภทนั้นอย่างเดียว</span>
    </div>
    <button class="mfbtn" id="mfbtn" data-act="mfilt" aria-expanded="${f.mfOpen}" aria-controls="mfilt"></button>
    <div class="mfilt ${f.mfOpen ? 'open' : ''}" id="mfilt">
      <div class="tagrow" id="tagrow">
        <span class="rowlab">แท็ก</span>
        <input class="tagfind" data-tf="tagQ" type="search" placeholder="ค้นแท็ก" value="${esc(f.tagQ)}" aria-label="ค้นแท็ก">
        <span id="tagchips" style="display:contents"></span>
      </div>
      <div class="tagrow" id="whorow">
        <span class="rowlab who">ผู้กล่าว</span>
        <input class="tagfind" data-tf="whoQ" type="search" placeholder="ค้นชื่อ" value="${esc(f.whoQ)}" aria-label="ค้นชื่อผู้กล่าว">
        <span id="whochips" style="display:contents"></span>
      </div>
    </div>
    <div class="recent" id="recent"></div>
    <div class="info" id="info" aria-live="polite"></div>
    <div id="results"></div>`, '#/');

  const q = document.getElementById('q');
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { f.q = q.value; renderRecent(); renderResults(); }, 120);
  });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
  document.querySelectorAll('.tagfind').forEach((inp) => inp.addEventListener('input', () => {
    f[inp.dataset.tf] = inp.value;
    inp.dataset.tf === 'tagQ' ? renderTagChips() : renderWhoChips();
  }));
  bindLongPress(document.getElementById('typesel'));
  renderAllFilters();
}

// อัปเดตป้ายอ่านแล้ว/ใหม่/% ในรายการ หลังปิดหน้าต่างอ่าน
function refreshCards() {
  if (S.view !== 'search' || !document.getElementById('results')) return;
  const keep = window.scrollY;
  renderMine(); renderRecent(); renderResults();
  window.scrollTo(0, keep);
}

function renderAllFilters() {
  renderMine(); renderTypeSel(); renderTagChips(); renderWhoChips(); renderMfBtn(); renderRecent(); renderResults();
}

function countBy(list, pick) {
  const m = new Map();
  for (const s of list) for (const v of pick(s)) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'));
}

function setOff(set) {
  S.f.off = set;
  store.set('yom-off', [...set]);
}

const MINE = [['all', 'ทุกเรื่อง'], ['unread', 'ยังไม่อ่าน'], ['reading', 'อ่านค้าง'], ['new', 'มาใหม่'], ['fav', '★ ที่ชอบ']];
const MINE_TEST = {
  all: () => true,
  unread: (s) => !isQuote(s) && !isRead(s),
  reading: inProgress,
  new: isNew,
  fav: (s) => S.me.fav.has(s.id),
};

function renderMine() {
  const box = document.getElementById('minesel');
  if (!box) return;
  const n = (k) => S.stories.filter(MINE_TEST[k]).length;
  box.innerHTML = MINE.map(([k, l]) => {
    const c = k === 'all' ? '' : n(k);
    return `<button data-act="mine" data-v="${k}" aria-pressed="${S.f.mine === k}" class="m-${k}">${l}${c ? ` <span class="n">${c}</span>` : ''}</button>`;
  }).join('');
}

function renderTypeSel() {
  const off = S.f.off;
  document.getElementById('typesel').innerHTML =
    `<button class="tall" data-act="tall" aria-pressed="${!off.size}">ทั้งหมด</button>` +
    TYPES.map((t) => `<button class="tsel" style="${tc(t)}" data-act="tsel" data-v="${t}" aria-pressed="${!off.has(t)}" title="แตะค้าง = ดู${t}อย่างเดียว">${t}</button>`).join('');
}

// แถวแท็ก: ที่เลือกอยู่ขึ้นก่อน ตามด้วยแท็กที่ใช้บ่อย · ค้นแท็กได้ · กด "อีก N" เพื่อดูทั้งหมด
function chipRow(boxId, all, selected, query, showAll, kind) {
  const box = document.getElementById(boxId);
  const q = norm(query);
  const pool = all.filter(([t]) => !selected.has(t) && (!q || norm(t).includes(q)));
  const LIMIT = 14;
  const shown = showAll || q ? pool : pool.slice(0, LIMIT);
  const rest = pool.length - shown.length;
  const cls = kind === 'who' ? 'tag who' : 'tag';
  const act = kind === 'who' ? 'who' : 'tag';
  const count = Object.fromEntries(all);
  box.innerHTML = [...selected].map((t) =>
      `<button class="${cls}" data-act="${act}" data-v="${esc(t)}" aria-pressed="true">${esc(t)} <span class="n">${count[t] || 0}</span></button>`).join('') +
    shown.map(([t, c]) => `<button class="${cls}" data-act="${act}" data-v="${esc(t)}" aria-pressed="false">${esc(t)} <span class="n">${c}</span></button>`).join('') +
    (rest > 0 ? `<button class="tag more" data-act="${act}-all">อีก ${rest} ${kind === 'who' ? 'ชื่อ' : 'แท็ก'}</button>` : '') +
    (showAll && !q && pool.length > LIMIT ? `<button class="tag more" data-act="${act}-all">ย่อ</button>` : '') +
    (q && !pool.length && ![...selected].some((t) => norm(t).includes(q)) ? '<span class="nomatch">ไม่พบ</span>' : '') +
    (selected.size ? `<button class="tag clear" data-act="${act}-clear">ล้างที่เลือก</button>` : '');
}

function renderTagChips() {
  chipRow('tagchips', countBy(S.stories, (s) => s.tags), S.f.tags, S.f.tagQ, S.f.tagAll, 'tag');
}

function renderWhoChips() {
  const all = countBy(S.stories, (s) => s.speakers);
  document.getElementById('whorow').hidden = !all.length;
  if (all.length) chipRow('whochips', all, S.f.who, S.f.whoQ, S.f.whoAll, 'who');
}

function renderMfBtn() {
  const n = S.f.tags.size + S.f.who.size;
  document.getElementById('mfbtn').innerHTML =
    `${S.f.mfOpen ? 'ซ่อนแท็กและผู้กล่าว' : 'กรองด้วยแท็ก / ผู้กล่าว'}${n ? ` <span class="n">เลือกอยู่ ${n}</span>` : ''}<span class="arr">${S.f.mfOpen ? '▴' : '▾'}</span>`;
}

function renderRecent() {
  const box = document.getElementById('recent');
  const f = S.f;
  const idle = !f.q.trim() && !f.tags.size && !f.who.size;
  const list = store.get('yom-recent', []).map((id) => S.stories.find((s) => s.id === id)).filter(Boolean).slice(0, 8);
  box.innerHTML = idle && list.length
    ? `<span class="lab">เปิดล่าสุด</span>${list.map((s) => `<a class="tag" href="#/s/${encodeURIComponent(s.id)}">${isRead(s) ? '✓ ' : ''}${inProgress(s) ? `<span class="pct">${readInfo(s).position}%</span> ` : ''}${esc(s.title)}</a>`).join('')}`
    : '';
}

function renderResults() {
  const f = S.f;
  const q = f.q.trim();
  const found = search(S.index, f, S.tags);
  const extra = found.extra;
  const list = found.list.filter(MINE_TEST[f.mine]);
  const filtered = q || f.tags.size || f.who.size || f.off.size || f.draftsOnly || f.mine !== 'all';
  const readable = S.stories.filter((s) => !isQuote(s) && s.status === 'published');
  const readN = readable.filter(isRead).length;
  const bits = [
    `${filtered ? 'พบ' : 'ทั้งหมด'} ${list.length} เรื่อง`,
    f.mine !== 'all' ? MINE.find(([k]) => k === f.mine)[1].replace('★ ', '') : '',
    f.off.size ? `ซ่อนอยู่ ${f.off.size} ประเภท` : '',
    f.tags.size ? `แท็ก: ${[...f.tags].join(' + ')}` : '',
    f.who.size ? `ผู้กล่าว: ${[...f.who].join(' หรือ ')}` : '',
  ].filter(Boolean).join(' · ');
  const progress = readN ? `<span class="readcount" title="นับเฉพาะเรื่องที่ไม่ใช่คำคม">อ่านแล้ว ${readN} จาก ${readable.length} เรื่อง</span>` : '';
  document.getElementById('info').innerHTML = `<span>${esc(bits)}${extra.length ? ` <span class="hint">(รวมคำใกล้เคียง: ${esc(extra.join(', '))})</span>` : ''}</span>${progress}`;

  const box = document.getElementById('results');
  if (!list.length) {
    box.innerHTML = `<div class="empty">${f.off.size >= TYPES.length
      ? '<strong>ยังไม่ได้เลือกประเภท</strong>แตะ “ทั้งหมด” หรือเลือกประเภทที่อยากอ่าน'
      : S.stories.length
        ? (f.mine !== 'all' && found.list.length
          ? `<strong>ไม่มีเรื่องใน “${MINE.find(([k]) => k === f.mine)[1]}”</strong>${f.mine === 'fav' ? 'กด ☆ ที่เรื่องไหนก็ได้เพื่อเก็บไว้ที่นี่' : 'แตะ “ทุกเรื่อง” เพื่อดูทั้งหมด'}`
          : '<strong>ไม่พบเรื่องที่ตรงกับคำค้น</strong>ลองคำที่สั้นลง เปิด “ค้นคำใกล้เคียงด้วย” หรือล้างแท็กที่เลือก')
        : `<strong>คลังยังว่างอยู่</strong>${isEditor() ? '<a href="#/new">เพิ่มเรื่องแรก</a>' : 'ทีมงานกำลังเตรียมเนื้อหา'}`}</div>`;
    return;
  }
  const terms = norm(q).split(' ').filter(Boolean);
  // แยกกลุ่มตามหมวด
  box.innerHTML = TYPES.map((t) => {
    const items = list.filter((s) => s.type === t);
    if (!items.length) return '';
    // ไม่ได้พิมพ์ค้น: หนังสือแสดงเป็นเล่ม · พิมพ์ค้น: แสดงบทที่ตรง พร้อมบอกว่ามาจากเล่มไหน
    if (t === 'หนังสือ' && !q) {
      const groups = new Map();
      const loose = [];
      for (const s of items) {
        const b = bookOf(s);
        if (!b) loose.push(s);
        else if (!groups.has(b)) groups.set(b, [s]);
        else groups.get(b).push(s);
      }
      const n = groups.size + loose.length;
      return `<h2 class="group-h" style="${tc(t)}">${t}<small>${n} เล่ม</small></h2>
        <div class="results">${[...groups.keys()].map((b) => bookCard(b, groups.get(b))).join('')}${loose.map((s) => card(s, q, terms)).join('')}</div>`;
    }
    return `<h2 class="group-h" style="${tc(t)}">${t}<small>${items.length} ${t === 'หนังสือ' ? 'บท' : 'เรื่อง'}</small></h2>
      <div class="results">${items.map((s) => card(s, q, terms)).join('')}</div>`;
  }).join('');
}

function favBtn(s, cls = '') {
  const on = S.me.fav.has(s.id);
  return `<button class="fav ${cls}" data-act="fav" data-v="${esc(s.id)}" aria-pressed="${on}" title="${on ? 'เอาออกจากเรื่องที่ชอบ' : 'เก็บไว้ในเรื่องที่ชอบ'}" aria-label="${on ? 'เอาออกจากเรื่องที่ชอบ' : 'เก็บไว้ในเรื่องที่ชอบ'}">${on ? '★' : '☆'}</button>`;
}

function readBadge(s) {
  if (isRead(s)) return '<span class="rd done">✓ อ่านแล้ว</span>';
  if (inProgress(s)) {
    const p = readInfo(s).position;
    return `<span class="rd prog"><span class="bar" style="--p:${p}%"></span>อ่านถึง ${p}%</span>`;
  }
  return '';
}

function card(s, q, terms) {
  const href = `#/s/${encodeURIComponent(s.id)}`;
  const quote = s.type === 'คำคม';
  const badges = `${s.status === 'draft' ? '<span class="badge-draft">ร่าง</span> ' : ''}${isNew(s) ? '<span class="badge-new">ใหม่</span> ' : ''}`;
  const title = quote
    ? `<p class="brief quote"><a href="${href}" style="text-decoration:none">${terms.length ? markTerms(s.body, terms) : esc(s.body)}</a></p>`
    : `<h3><a href="${href}">${badges}${terms.length ? markTerms(s.title, terms) : esc(s.title)}</a></h3>`;
  const brief = quote ? '' : `<p class="brief ${terms.length ? 'snip' : ''}">${excerptHtml(s, q)}</p>`;
  return `<article class="result ${isRead(s) ? 'is-read' : ''}" style="${tc(s.type)}" data-id="${esc(s.id)}">
    ${quote && (s.status === 'draft' || isNew(s)) ? `<div>${badges}</div>` : ''}
    ${title}
    <div class="meta">
      <span class="ttype">${s.type}</span>${s.attachments.length ? ICON.clip : ''}
      ${bookOf(s) ? bookRef(s) : ''}
      ${s.speakers.map((n) => `<button class="whochip" data-act="who" data-v="${esc(n)}" title="กรองเฉพาะเรื่องของ ${esc(n)}">${esc(n)}</button>`).join('')}
      ${s.source ? `<span>ที่มา: ${esc(s.source)}</span>` : ''}
    </div>
    ${brief}
    ${s.tags.length ? `<div class="chips">${s.tags.map((t) => `<button class="chip" data-act="tag" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="rfoot"><span class="rstat">เพิ่มเมื่อ ${thaiDate(s.created_at)}${readBadge(s)}</span>
      <span class="ract">${favBtn(s)}<a class="btn small" href="${href}">${inProgress(s) ? 'อ่านต่อ' : 'อ่าน'}</a></span></div>
  </article>`;
}

function bookRef(s) {
  const list = chapters(s.book);
  const i = list.findIndex((x) => x.id === s.id) + 1;
  return `<a class="bookref" href="${bookHref(s.book)}" title="เปิดอ่านทั้งเล่ม">${ICON.book}${esc(s.book)}<span class="chno">บทที่ ${i}/${list.length}</span></a>`;
}

// บทที่อ่านค้างในเล่ม: เครื่องนี้จำไว้ = ใช้อันนั้น · เปิดจากเครื่องอื่น = บทแรกที่ยังไม่อ่าน (สถานะอ่านแล้วซิงก์ทุกเครื่อง)
function bookAt(name, list) {
  const at = store.get('yom-bookpos', {})[name];
  if (at && list.some((x) => x.id === at)) return at;
  if (!list.some(isRead)) return null;
  return list.find((x) => !isRead(x))?.id || null;
}

// การ์ดหนังสือทั้งเล่ม: สารบัญย่อ + อ่านไปกี่บทแล้ว
function bookCard(name, shown) {
  const all = chapters(name);
  const done = all.filter(isRead).length;
  const who = [...new Set(all.flatMap((x) => x.speakers))];
  const tags = [...new Set(all.flatMap((x) => x.tags))];
  const at = bookAt(name, all);
  const resume = at && done < all.length;
  const SHOW = 5;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  return `<article class="result bookcard ${done === all.length ? 'is-read' : ''}" style="${tc('หนังสือ')}">
    <h3><a href="${bookHref(name)}">${all.some(isNew) ? '<span class="badge-new">ใหม่</span> ' : ''}${esc(name)}</a></h3>
    <div class="meta"><span class="ttype">หนังสือ</span><span>${all.length} บท</span>
      ${who.map((n) => `<button class="whochip" data-act="who" data-v="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <ol class="toc mini">${all.slice(0, SHOW).map((x) => `<li class="${isRead(x) ? 'done' : ''}"><a href="#/s/${encodeURIComponent(x.id)}">${esc(x.title)}</a>${isRead(x) ? ' <span class="ok">✓</span>' : ''}</li>`).join('')}
      ${all.length > SHOW ? `<li class="more"><a href="${bookHref(name)}">และอีก ${all.length - SHOW} บท</a></li>` : ''}</ol>
    ${shown.length < all.length ? `<p class="hint">ตรงกับตัวกรอง ${shown.length} บท</p>` : ''}
    ${tags.length ? `<div class="chips">${tags.map((t) => `<button class="chip" data-act="tag" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="rfoot"><span class="rstat">${done ? `<span class="rd ${done === all.length ? 'done' : 'prog'}">${done === all.length ? '✓ อ่านครบทั้งเล่ม' : `<span class="bar" style="--p:${pct}%"></span>อ่านแล้ว ${done}/${all.length} บท`}</span>` : `เพิ่มเมื่อ ${thaiDate(all[0]?.created_at)}`}</span>
      <span class="ract"><a class="btn small" href="${bookHref(name)}">${resume ? 'อ่านต่อ' : 'อ่านทั้งเล่ม'}</a></span></div>
  </article>`;
}

// แตะค้างที่ประเภท = ดูประเภทนั้นอย่างเดียว
function bindLongPress(el) {
  let timer = null;
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.tsel');
    if (!b) return;
    timer = setTimeout(() => {
      timer = null;
      S.longPressed = true;
      setOff(new Set(TYPES.filter((t) => t !== b.dataset.v)));
      renderTypeSel(); renderResults();
    }, 500);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ===================================================================== หน้าต่างอ่าน
function openDrawer(id) {
  flushPos();
  const s = S.stories.find((x) => x.id === id);
  if (S.stack.at(-2) === id) S.stack.pop();
  else { if (!S.stack.length) S.stackFromApp = S.inApp > 0; S.stack.push(id); }
  let d = document.querySelector('.drawer');
  if (!d) {
    document.body.insertAdjacentHTML('beforeend', '<div class="scrim" data-act="close"></div><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="d-title"></section>');
    d = document.querySelector('.drawer');
    document.body.classList.add('locked');
  }
  if (!s) {
    d.style.cssText = '';
    d.innerHTML = `<div class="d-head"><span class="spacer"></span><button class="btn small" data-act="close">ปิด ✕</button></div>
      <div class="d-body"><div class="empty"><strong id="d-title">ไม่พบเรื่องนี้</strong>อาจถูกย้ายไปถังขยะ หรือยังไม่เผยแพร่</div></div>`;
    return;
  }
  store.set('yom-recent', [s.id, ...store.get('yom-recent', []).filter((x) => x !== s.id)].slice(0, 12));
  renderRecent();

  const quote = s.type === 'คำคม';
  const book = bookOf(s);
  const chs = book ? chapters(book) : [];
  const ci = chs.findIndex((x) => x.id === s.id);
  const chnav = book ? `<nav class="chnav" aria-label="บทในเล่ม">
      ${ci > 0 ? `<a class="btn" href="#/s/${encodeURIComponent(chs[ci - 1].id)}">‹ ${esc(chs[ci - 1].title)}</a>` : '<span></span>'}
      <a class="btn" href="${bookHref(book)}">${ICON.book} ทั้งเล่ม</a>
      ${ci < chs.length - 1 ? `<a class="btn primary" href="#/s/${encodeURIComponent(chs[ci + 1].id)}">${esc(chs[ci + 1].title)} ›</a>` : '<span></span>'}
    </nav>` : '';
  const files = s.attachments.length ? `<div class="atts">${s.attachments.map((p) => isPdf(p)
    ? `<a class="btn" href="${esc(S.api.fileUrl(p))}" target="_blank" rel="noopener">ดูไฟล์ต้นฉบับ (PDF)</a>`
    : `<img src="${esc(S.api.fileUrl(p))}" alt="ภาพต้นฉบับของ ${esc(s.title)}" loading="lazy">`).join('')}</div>` : '';
  const rel = related(s);
  const r0 = readInfo(s);
  const resumeAt = !quote && r0 && !r0.read_at && r0.position >= 3 && r0.position < 95 ? r0.position : 0;
  const by = isEditor() ? byline(s) : '';

  d.style.cssText = tc(s.type);
  d.innerHTML = `
    <div class="d-head">
      ${S.stack.length > 1 ? '<button class="btn small" data-act="dback">‹ กลับ</button>' : ''}
      <span class="spacer"></span>
      ${favBtn(s, 'btn small')}
      ${quote ? '' : `<button class="btn small readtg" data-act="readtg" data-v="${esc(s.id)}"></button>`}
      <button class="btn small" data-act="font" data-v="-2" aria-label="ตัวอักษรเล็กลง">ก−</button>
      <button class="btn small" data-act="font" data-v="2" aria-label="ตัวอักษรใหญ่ขึ้น">ก+</button>
      ${isEditor() ? `<a class="btn small" href="#/edit/${encodeURIComponent(s.id)}">แก้ไข</a>` : ''}
      <button class="btn small" data-act="close" aria-label="ปิด">ปิด ✕</button>
      ${quote ? '' : '<div class="d-prog" aria-hidden="true"><span></span></div>'}
    </div>
    <div class="d-body">
      ${resumeAt ? `<button class="resume" data-act="resume" data-v="${resumeAt}">อ่านต่อจากที่ค้างไว้ <strong>${resumeAt}%</strong> ↓</button>` : ''}
      <div class="meta"><span class="ttype">${s.type}</span>${book ? bookRef(s) : ''}${s.status === 'draft' ? '<span class="badge-draft">ร่าง ยังไม่เผยแพร่</span>' : ''}
        ${s.speakers.map((n) => `<a class="whochip" href="#/?who=${encodeURIComponent(n)}" title="ดูเรื่องทั้งหมดของ ${esc(n)}">${esc(n)}</a>`).join('')}
        ${s.source ? `<span>ที่มา: ${esc(s.source)}</span>` : ''}
        <span>เพิ่มเมื่อ ${thaiDate(s.created_at)}</span>
      </div>
      <h2 id="d-title" class="${quote ? 'sr-only' : ''}">${esc(s.title)}</h2>
      <div class="reading ${quote ? 'quote' : ''}">${bodyHtml(s)}</div>
      ${files}
      ${chnav}
      ${s.tags.length ? `<div class="sec-h">แท็ก</div><div class="chips">${s.tags.map((t) => `<a class="chip" href="#/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
      ${by}
      ${rel.length ? `<div class="sec-h">เรื่องที่เกี่ยวข้อง</div><ul class="related">${rel.map((r) =>
        `<li><a href="#/s/${encodeURIComponent(r.id)}" style="${tc(r.type)}"><span class="t">${esc(r.title)}</span><span class="ttype">${r.type}</span></a></li>`).join('')}</ul>` : ''}
    </div>`;
  const body = d.querySelector('.d-body');
  body.scrollTop = 0;
  d.querySelector('[data-act="close"]').focus({ preventScroll: true });
  trackReading(s, body);
}

// ---- อ่านทั้งเล่ม: สารบัญ + ทุกบทต่อกัน · จำบทล่าสุดที่อ่านถึง · บทที่เลื่อนผ่านจนจบ = อ่านแล้ว
function openBook(name) {
  flushPos();
  const key = 'b:' + name;
  if (S.stack.at(-2) === key) S.stack.pop();
  else { if (!S.stack.length) S.stackFromApp = S.inApp > 0; S.stack.push(key); }
  let d = document.querySelector('.drawer');
  if (!d) {
    document.body.insertAdjacentHTML('beforeend', '<div class="scrim" data-act="close"></div><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="d-title"></section>');
    d = document.querySelector('.drawer');
    document.body.classList.add('locked');
  }
  const list = chapters(name);
  d.style.cssText = tc('หนังสือ');
  if (!list.length) {
    d.innerHTML = `<div class="d-head"><span class="spacer"></span><button class="btn small" data-act="close">ปิด ✕</button></div>
      <div class="d-body"><div class="empty"><strong id="d-title">ไม่พบหนังสือเล่มนี้</strong>อาจถูกย้ายไปถังขยะ หรือยังไม่เผยแพร่</div></div>`;
    return;
  }
  const who = [...new Set(list.flatMap((x) => x.speakers))];
  const tags = [...new Set(list.flatMap((x) => x.tags))];
  const done = list.filter(isRead).length;
  const at = bookAt(name, list);
  const atCh = at && at !== list[0].id ? list.find((x) => x.id === at) : null;
  d.innerHTML = `
    <div class="d-head">
      ${S.stack.length > 1 ? '<button class="btn small" data-act="dback">‹ กลับ</button>' : ''}
      <span class="spacer"></span>
      <button class="btn small" data-act="font" data-v="-2" aria-label="ตัวอักษรเล็กลง">ก−</button>
      <button class="btn small" data-act="font" data-v="2" aria-label="ตัวอักษรใหญ่ขึ้น">ก+</button>
      ${isEditor() ? `<a class="btn small" href="#/new?book=${encodeURIComponent(name)}">+ เพิ่มบท</a>` : ''}
      <button class="btn small" data-act="close" aria-label="ปิด">ปิด ✕</button>
      <div class="d-prog" aria-hidden="true"><span></span></div>
    </div>
    <div class="d-body">
      ${atCh ? `<button class="resume" data-act="goch" data-v="${esc(atCh.id)}">อ่านต่อจากบท <strong>${esc(atCh.title)}</strong> ↓</button>` : ''}
      <div class="meta"><span class="ttype">หนังสือ</span><span>${list.length} บท</span>
        ${who.map((n) => `<a class="whochip" href="#/?who=${encodeURIComponent(n)}">${esc(n)}</a>`).join('')}
        <span class="bookdone">${done ? `อ่านแล้ว ${done}/${list.length} บท` : ''}</span></div>
      <h2 id="d-title">${esc(name)}</h2>
      <nav class="toc" aria-label="สารบัญ"><div class="sec-h">สารบัญ</div><ol>
        ${list.map((x) => `<li class="${isRead(x) ? 'done' : ''}" data-toc="${esc(x.id)}"><button data-act="goch" data-v="${esc(x.id)}">${esc(x.title)}</button><span class="ok">${isRead(x) ? '✓' : ''}</span></li>`).join('')}
      </ol></nav>
      ${list.map((x, i) => `<section class="chap" id="ch-${esc(x.id)}" data-id="${esc(x.id)}">
        <h3><span class="chno">บทที่ ${i + 1}</span>${esc(x.title)}${x.status === 'draft' ? ' <span class="badge-draft">ร่าง</span>' : ''}
          ${isEditor() ? `<a class="btn small edit" href="#/edit/${encodeURIComponent(x.id)}">แก้ไข</a>` : ''}</h3>
        <div class="reading">${bodyHtml(x)}</div>
        ${x.attachments.length ? `<div class="atts">${x.attachments.map((p) => isPdf(p)
          ? `<a class="btn" href="${esc(S.api.fileUrl(p))}" target="_blank" rel="noopener">ดูไฟล์ต้นฉบับ (PDF)</a>`
          : `<img src="${esc(S.api.fileUrl(p))}" alt="ภาพต้นฉบับของ ${esc(x.title)}" loading="lazy">`).join('')}</div>` : ''}
        ${x.source ? `<p class="byline">ที่มา: ${esc(x.source)}</p>` : ''}
      </section>`).join('')}
      ${tags.length ? `<div class="sec-h">แท็ก</div><div class="chips">${tags.map((t) => `<a class="chip" href="#/?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}</div>` : ''}
    </div>`;
  const body = d.querySelector('.d-body');
  body.scrollTop = 0;
  d.querySelector('[data-act="close"]').focus({ preventScroll: true });
  trackBook(name, list, body);
}

function trackBook(name, list, body) {
  S.rd = { id: null, pos: null, book: name };
  const bar = document.querySelector('.d-prog span');
  const secs = [...body.querySelectorAll('.chap')];
  let t;
  const check = () => {
    const max = body.scrollHeight - body.clientHeight;
    if (bar) bar.style.width = (max <= 0 ? 100 : Math.round((body.scrollTop / max) * 100)) + '%';
    const top = body.getBoundingClientRect().top;
    const bottom = top + body.clientHeight;
    let cur = null;
    for (const sec of secs) {
      const r = sec.getBoundingClientRect();
      if (r.top <= top + 120) cur = sec.dataset.id;
      // เลื่อนจนเห็นท้ายบท = อ่านบทนั้นแล้ว
      if (r.bottom <= bottom + 4 && r.bottom > top) {
        const s = list.find((x) => x.id === sec.dataset.id);
        if (s && !isRead(s)) {
          putRead(s.id, { position: 100, read_at: new Date().toISOString() });
          const li = body.querySelector(`[data-toc="${CSS.escape(s.id)}"]`);
          if (li) { li.classList.add('done'); li.querySelector('.ok').textContent = '✓'; }
          const n = list.filter(isRead).length;
          body.querySelector('.bookdone').textContent = `อ่านแล้ว ${n}/${list.length} บท`;
        }
      }
    }
    if (max > 0 && body.scrollTop >= max - 4) {   // เลื่อนสุดแล้ว = บทสุดท้ายที่โผล่บนจอ
      const vis = secs.filter((x) => x.getBoundingClientRect().top < bottom);
      if (vis.length) cur = vis.at(-1).dataset.id;
    }
    if (cur) {
      clearTimeout(t);
      t = setTimeout(() => store.set('yom-bookpos', { ...store.get('yom-bookpos', {}), [name]: cur }), 600);
    }
  };
  body.addEventListener('scroll', check, { passive: true });
  // เปิดเล่มแล้ว = บทในเล่มไม่ใช่ "ใหม่" อีก
  for (const x of list) if (!readInfo(x)) putRead(x.id, { position: 0, read_at: null });
}

// ---- ติดตามการอ่านในหน้าต่างอ่าน
// เรื่องสั้น (ไม่ต้องเลื่อน) = อ่านแล้วทันที · เรื่องยาว = จำ % ที่เลื่อนถึง และถือว่าอ่านจบเมื่อถึง 95%
function trackReading(s, body) {
  S.rd = { id: s.id, pos: null, timer: null };
  if (!readInfo(s)) putRead(s.id, { position: 0, read_at: null });   // เปิดแล้ว = ไม่ใช่ "ใหม่" อีก
  updateReadBtn(s);
  if (isQuote(s)) return;
  const bar = document.querySelector('.d-prog span');
  const pct = () => {
    const max = body.scrollHeight - body.clientHeight;
    return max <= 40 ? 100 : Math.min(100, Math.round((body.scrollTop / max) * 100));
  };
  requestAnimationFrame(() => {
    if (body.scrollHeight - body.clientHeight <= 40) {
      if (bar) bar.style.width = '100%';
      if (!isRead(s)) { putRead(s.id, { position: 100, read_at: new Date().toISOString() }); updateReadBtn(s); }
    }
  });
  body.addEventListener('scroll', () => {
    const p = pct();
    if (bar) bar.style.width = p + '%';
    if (S.rd?.id !== s.id) return;
    S.rd.pos = p;
    clearTimeout(S.rd.timer);
    S.rd.timer = setTimeout(flushPos, 1500);
    if (p >= 95 && !isRead(s)) { putRead(s.id, { position: 100, read_at: new Date().toISOString() }); updateReadBtn(s); }
  }, { passive: true });
}

function flushPos() {
  const rd = S.rd;
  if (!rd || rd.pos == null) return;
  clearTimeout(rd.timer);
  const s = S.stories.find((x) => x.id === rd.id);
  if (s && !isRead(s) && rd.pos >= 3) putRead(s.id, { position: rd.pos });
  rd.pos = null;
}

function updateReadBtn(s) {
  const b = document.querySelector('.readtg');
  if (!b) return;
  const on = isRead(s);
  b.textContent = on ? '✓ อ่านแล้ว' : '○ อ่านแล้ว';
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', on);
  b.title = on ? 'แตะเพื่อกลับเป็นยังไม่อ่าน' : 'แตะเพื่อทำเครื่องหมายว่าอ่านจบแล้ว';
}

// เพิ่มโดย / แก้ล่าสุดโดย (เห็นเฉพาะทีมงาน)
function byline(s) {
  const name = (id) => (id && S.people[id]) || 'ไม่ทราบชื่อ';
  const edited = s.updated_at && s.updated_at !== s.created_at && (s.updated_by || s.updated_at.slice(0, 16) !== s.created_at.slice(0, 16));
  return `<p class="byline">เพิ่มโดย <strong>${esc(name(s.created_by))}</strong> · ${thaiDate(s.created_at)}${
    edited ? ` <span class="sep">·</span> แก้ล่าสุดโดย <strong>${esc(name(s.updated_by || s.created_by))}</strong> · ${thaiDate(s.updated_at)}` : ''}</p>`;
}

function closeDrawer() {
  flushPos();
  const had = !!S.rd;
  S.rd = null;
  if (had) refreshCards();
  document.querySelector('.drawer')?.remove();
  document.querySelector('.scrim')?.remove();
  document.body.classList.remove('locked');
  S.stack = [];
}

function bodyHtml(s) {
  let html = esc(s.body);
  [...s.highlights].sort((a, b) => b.length - a.length).forEach((h) => {
    const e = esc(h);
    if (e) html = html.split(e).join(`<mark>${e}</mark>`);
  });
  return html;
}

function related(s) {
  return S.stories
    .filter((x) => x.id !== s.id && (!bookOf(s) || bookOf(x) !== bookOf(s)))
    .map((x) => ({ x, n: x.tags.filter((t) => s.tags.includes(t)).length * 2 + x.speakers.filter((p) => s.speakers.includes(p)).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((r) => r.x);
}

function setRead(px) {
  const v = Math.max(15, Math.min(32, px));
  document.documentElement.style.setProperty('--read', v + 'px');
  store.set('yom-fs', v);
}

// ===================================================================== เพิ่ม / แก้ไขเรื่อง (ตามแท็บเพิ่มข้อมูลของแอป)
const whoLabel = (type) => (type === 'โอวาท' ? 'ผู้ให้โอวาท' : type === 'หนังสือ' ? 'ผู้เขียน / ผู้แสดงธรรม' : 'ผู้กล่าว / แหล่ง');

function viewEditor(id, params = new URLSearchParams()) {
  const s = id ? S.stories.find((x) => x.id === id) : null;
  if (id && !s) { location.hash = '#/'; return; }
  S.view = 'editor';
  S.ed = s ? {
    id: s.id, type: s.type, title: s.title, body: s.body, highlights: [...s.highlights], tags: [...s.tags],
    speakers: [...s.speakers], source: s.source, attachments: [...s.attachments], status: s.status,
    book: s.book || '', book_order: s.book_order ?? '',
    expect: s.updated_at, pending: [],
  } : {
    id: null, type: store.get('yom-last-type', 'เรื่องเล่า'), title: '', body: '', highlights: [], tags: [], speakers: [],
    source: '', attachments: [], status: 'published', expect: null, pending: [],
    book: '', book_order: '',
  };
  // มาจากปุ่ม "+ เพิ่มบท" ในหน้าหนังสือ
  const pb = params.get('book');
  if (!s && pb) {
    const first = chapters(pb)[0];
    Object.assign(S.ed, { type: 'หนังสือ', book: pb, book_order: nextOrder(pb), speakers: first ? [...first.speakers] : [], tags: [] });
  }
  S.ed.orderAuto = !s;
  S.ed.bulk = false;
  S.ed.split = store.get('yom-bulk-split', 'blank');

  app.innerHTML = shell(`
    <div class="page">
      <h1>${s ? 'แก้ไขเรื่อง' : 'เพิ่มข้อมูล'}</h1>
      <form id="ed" class="panel" novalidate>
        <div class="field"><span class="label" id="lbl-type">ประเภท</span>
          <div class="seg typesel typepick" id="ed-type" role="radiogroup" aria-labelledby="lbl-type"></div></div>

        <div class="field only-book bookrow">
          <div class="grow"><label for="ed-book">ชื่อหนังสือ <span class="hint">พิมพ์ชื่อเล่มเดิมเพื่อเพิ่มบทต่อ หรือชื่อใหม่เพื่อเริ่มเล่มใหม่</span></label>
            <input class="input" id="ed-book" list="book-list" value="${esc(S.ed.book)}" autocomplete="off">
            <datalist id="book-list">${bookNames().map((b) => `<option value="${esc(b)}">`).join('')}</datalist></div>
          <div data-nobulk><label for="ed-order">บทที่</label>
            <input class="input order" id="ed-order" type="number" min="1" inputmode="numeric" value="${esc(S.ed.book_order)}"></div>
        </div>
        <p class="hint only-book" id="book-hint"></p>

        ${s ? '' : `<div class="field only-multi">
          <span class="label" id="lbl-bulk">วิธีเพิ่ม</span>
          <div class="seg pick" id="ed-bulk" role="radiogroup" aria-labelledby="lbl-bulk"></div>
        </div>`}

        <div class="field" id="f-title" data-nobulk>
          <label for="ed-title"><span id="title-label">ชื่อเรื่อง</span> <span class="hint" id="title-hint"></span></label>
          <input class="input" id="ed-title" value="${esc(S.ed.title)}" autocomplete="off">
        </div>

        <div class="field">
          <label for="ed-body" id="body-label">เนื้อหา <span class="hint">กด Tab เพื่อย่อหน้า</span></label>
          <div class="bulkopt only-bulk only-quote">
            <span class="hint">แยกคำคมด้วย</span>
            <div class="seg" id="ed-split" role="radiogroup" aria-label="วิธีแยกคำคม"></div>
          </div>
          <div class="sugg hlbar" data-nobulk>
            <button type="button" class="btn small hlbtn" data-act="gem-add"><mark>ไฮไลต์</mark> / เอาออก</button>
            <span class="hint" id="hl-hint">ลากเลือกประโยคแล้วกดปุ่ม · วางเคอร์เซอร์ในข้อความที่ไฮไลต์แล้วกด = เอาออก</span>
          </div>
          <div class="hlwrap"><div class="hlback" id="ed-hl" aria-hidden="true"></div><textarea class="textarea" id="ed-body">${esc(S.ed.body)}</textarea></div>
          <div class="only-bulk" id="bulk-prev" aria-live="polite"></div>
        </div>

        <div class="field">
          <label for="ed-tag-in">แท็ก</label>
          <div class="tokbox"><span id="ed-tags" style="display:contents"></span>
            <input id="ed-tag-in" list="tag-list" placeholder="พิมพ์แท็กแล้วกด Enter" autocomplete="off"></div>
          <datalist id="tag-list">${S.tags.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist>
          <div class="sugg" id="ed-tag-sug"></div>
        </div>

        <div class="field">
          <label for="ed-sp-in"><span id="sp-label">${whoLabel(S.ed.type)}</span> <span class="hint only-bulk qhint">ใช้กับคำคมที่ไม่ได้ระบุชื่อท้ายข้อความ</span></label>
          <div class="tokbox"><span id="ed-sp" style="display:contents"></span>
            <input id="ed-sp-in" list="sp-list" placeholder="พิมพ์ชื่อแล้วกด Enter ใส่ได้หลายชื่อ" autocomplete="off"></div>
          <datalist id="sp-list">${countBy(S.stories, (x) => x.speakers).map(([n]) => `<option value="${esc(n)}">`).join('')}</datalist>
          <div class="sugg" id="ed-sp-sug"></div>
        </div>

        <div class="field">
          <label for="ed-source">รายละเอียดที่มา <span class="hint">เช่น ชื่อหนังสือและเลขหน้า วันที่ หรือสถานที่ (ไม่ใส่ก็ได้)</span></label>
          <input class="input" id="ed-source" value="${esc(S.ed.source)}" autocomplete="off">
        </div>

        <div class="field" data-nobulk>
          <span class="label">ไฟล์ต้นฉบับ <span class="hint">รูปหรือ PDF · รูปใหญ่จะถูกย่อให้เอง</span></span>
          <label class="btn" for="ed-file">${ICON.clip} แนบรูป / PDF</label>
          <input type="file" id="ed-file" accept="image/*,application/pdf" multiple hidden>
          <div class="thumbs" id="ed-files"></div>
        </div>

        <div class="field">
          <span class="label" id="lbl-status">สถานะ</span>
          <div class="seg status" id="ed-status" role="radiogroup" aria-labelledby="lbl-status"></div>
          <p class="hint">เผยแพร่ = โยมทุกคนเห็น · ร่าง = เห็นเฉพาะทีมงาน</p>
        </div>

        <div class="actions">
          <button type="submit" class="btn primary" id="ed-save">บันทึกลงคลัง</button>
          <a class="btn" href="${s ? `#/s/${encodeURIComponent(s.id)}` : '#/'}">ยกเลิก</a>
          <span class="spacer"></span>
          ${s ? '<button type="button" class="btn danger" data-act="trash">ย้ายไปถังขยะ</button>' : ''}
        </div>
        ${s ? byline(s) : ''}
      </form>
    </div>`, s ? '' : '#/new');

  const $ = (sel) => document.getElementById(sel);
  const dirty = () => { S.dirty = true; };
  $('ed-title').addEventListener('input', (e) => { S.ed.title = e.target.value; dirty(); });
  $('ed-source').addEventListener('input', (e) => { S.ed.source = e.target.value; dirty(); });
  $('ed-book').addEventListener('input', (e) => {
    S.ed.book = e.target.value; dirty();
    if (S.ed.orderAuto) { S.ed.book_order = S.ed.book.trim() ? nextOrder(S.ed.book.trim()) : ''; $('ed-order').value = S.ed.book_order; }
    edBookHint(); edBulkPreview();
  });
  $('ed-order').addEventListener('input', (e) => { S.ed.book_order = e.target.value; S.ed.orderAuto = false; dirty(); edBookHint(); });
  const body = $('ed-body');
  let tt;
  body.addEventListener('input', () => {
    S.ed.body = body.value; dirty();
    edGems(); growBody();
    clearTimeout(tt); tt = setTimeout(() => { if (S.view === 'editor') { edTags(); edBulkPreview(); } }, 250);
  });
  body.addEventListener('keydown', onTabIndent);
  tokInput($('ed-tag-in'), 'tags', edTags);
  tokInput($('ed-sp-in'), 'speakers', edSpeakers);
  $('ed-file').addEventListener('change', (e) => {
    for (const file of e.target.files) S.ed.pending.push({ file, url: URL.createObjectURL(file) });
    e.target.value = '';
    dirty(); edFiles();
  });
  $('ed').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  // ลากไฟล์มาวางบนฟอร์มได้
  $('ed').addEventListener('dragover', (e) => e.preventDefault());
  $('ed').addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    for (const file of e.dataTransfer.files) if (/^image\/|pdf$/.test(file.type)) S.ed.pending.push({ file, url: URL.createObjectURL(file) });
    dirty(); edFiles();
  });

  edType(); edGems(); edTags(); edSpeakers(); edFiles(); edStatus(); edBookHint();
  growBody();
}

// กล่องเนื้อหายืดตามข้อความ (ไม่มีแถบเลื่อนในกล่อง) ไฮไลต์ด้านหลังจึงตรงกับตัวอักษรเสมอ
function growBody() {
  const ta = document.getElementById('ed-body');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.max(S.ed.bulk ? 240 : 260, ta.scrollHeight + 2) + 'px';
}

function edBookHint() {
  const el = document.getElementById('book-hint');
  if (!el) return;
  const b = S.ed.book.trim();
  const list = b ? chapters(b).filter((x) => x.id !== S.ed.id) : [];
  el.innerHTML = !b ? 'ไม่ใส่ชื่อหนังสือ = เป็นเรื่องเดี่ยว ไม่อยู่ในเล่มไหน'
    : list.length ? `เล่มนี้มีอยู่แล้ว ${list.length} บท: ${list.map((x) => esc(x.title)).slice(0, 6).join(' · ')}${list.length > 6 ? ' …' : ''}`
      : 'หนังสือเล่มใหม่';
}

// ---- เพิ่มคำคมทีละหลายอัน
function edBulk() {
  const box = document.getElementById('ed-bulk');
  const form = document.getElementById('ed');
  const t = S.ed.type;
  const multi = t === 'คำคม' || t === 'หนังสือ';
  if (!multi) S.ed.bulk = false;
  form.classList.toggle('quote-mode', t === 'คำคม');
  form.classList.toggle('multi-mode', multi && !S.ed.id);
  form.classList.toggle('bulk', S.ed.bulk);
  growBody();
  if (!box) return;
  const [one, many] = t === 'หนังสือ' ? ['ทีละบท', 'วางทั้งเล่ม'] : ['ทีละอัน', 'ทีละหลายอัน'];
  box.innerHTML = `
    <button type="button" role="radio" data-act="ed-bulk" data-v="one" aria-pressed="${!S.ed.bulk}" aria-checked="${!S.ed.bulk}">${one}</button>
    <button type="button" role="radio" data-act="ed-bulk" data-v="many" aria-pressed="${S.ed.bulk}" aria-checked="${S.ed.bulk}">${many}</button>`;
  if (t === 'หนังสือ') {
    document.getElementById('body-label').innerHTML = S.ed.bulk
      ? 'วางเนื้อหาทั้งเล่ม <span class="hint">ขึ้นบรรทัดใหม่ด้วย # หรือ “บทที่ …” = เริ่มบทใหม่ บรรทัดนั้นเป็นชื่อบท</span>'
      : 'เนื้อหา <span class="hint">กด Tab เพื่อย่อหน้า</span>';
    document.getElementById('ed-body').placeholder = S.ed.bulk
      ? '# คำนำ\nหนังสือเล่มนี้…\n\n# บทที่ 1 เริ่มต้นนั่งสมาธิ\nการนั่งสมาธิไม่จำเป็นต้อง…\n\nบทที่ 2 แผ่เมตตาก่อนนอน\nก่อนหลับ ลองนึกถึง…'
      : '';
    document.getElementById('ed-save').textContent = S.ed.bulk ? 'บันทึกทุกบท' : 'บันทึกลงคลัง';
    edBulkPreview();
    return;
  }
  document.getElementById('ed-split').innerHTML = [['blank', 'บรรทัดว่าง'], ['line', 'ขึ้นบรรทัดใหม่']].map(([v, l]) =>
    `<button type="button" role="radio" data-act="ed-split" data-v="${v}" aria-pressed="${S.ed.split === v}" aria-checked="${S.ed.split === v}">${l}</button>`).join('');
  document.getElementById('body-label').innerHTML = S.ed.bulk
    ? 'วางคำคมหลายอัน <span class="hint">ใส่ชื่อผู้กล่าวท้ายคำคมได้ เช่น “… — หลวงพ่อ”</span>'
    : 'เนื้อหา <span class="hint">กด Tab เพื่อย่อหน้า</span>';
  document.getElementById('ed-body').placeholder = S.ed.bulk
    ? (S.ed.split === 'blank'
      ? 'ความสุขอยู่ที่ใจ ไม่ได้อยู่ที่ของ\n— หลวงพ่อ\n\nโกรธเขา เท่ากับเอาไฟเผาตัวเอง'
      : 'ความสุขอยู่ที่ใจ ไม่ได้อยู่ที่ของ — หลวงพ่อ\nโกรธเขา เท่ากับเอาไฟเผาตัวเอง')
    : '';
  document.getElementById('ed-save').textContent = S.ed.bulk ? 'บันทึกคำคมทั้งหมด' : 'บันทึกลงคลัง';
  edBulkPreview();
}

// แยกข้อความยาวเป็นคำคมทีละอัน · ชื่อท้ายข้อความ (— ชื่อ) = ผู้กล่าวของคำคมนั้น
function parseBulk(text, mode) {
  const chunks = mode === 'line' ? text.split(/\n/) : text.split(/\n[ \t]*\n/);
  const DASH = /^\s*[—–]|^\s*-{1,2}\s/;
  const out = [];
  for (const raw of chunks) {
    let lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let who = '';
    // บรรทัดสุดท้ายขึ้นต้นด้วยขีด = ชื่อผู้กล่าว
    if (lines.length > 1 && DASH.test(lines.at(-1))) who = lines.pop().replace(/^\s*[—–-]+\s*/, '');
    let body = lines.join('\n');
    // หรือชื่อต่อท้ายในบรรทัดเดียวกัน: "… — ชื่อ"
    const m = !who && body.match(/\s[—–]\s*([^—–\n]{1,40})$/);
    if (m) { who = m[1].trim(); body = body.slice(0, m.index); }
    body = body
      .replace(/^(\d+[.)]|[•*·-])\s+/, '')               // เลขข้อ/สัญลักษณ์หน้าข้อ
      .replace(/^["“”'‘]+|["“”'’]+$/g, '')               // เครื่องหมายคำพูดครอบ
      .trim();
    if (body) out.push({ body, who: who.replace(/^["“”]|["“”]$/g, '').trim() });
  }
  return out;
}

// วางทั้งเล่ม: บรรทัดที่ขึ้นต้นด้วย # หรือ "บทที่/ตอนที่ …" = หัวบทใหม่ · ข้อความก่อนบทแรก = คำนำ
const HEAD_RE = /^\s*(#{1,6}\s*(.+)|((?:บทที่|ตอนที่|บท)\s*[0-9๐-๙]+.*))$/;
function parseBook(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.match(HEAD_RE);
    if (m) {
      // "บทที่ 1 ตึงไปก็ขาด" → ชื่อบท "ตึงไปก็ขาด" (เลขบทระบบใส่ให้เอง)
      const raw = (m[2] || m[3]).trim();
      const rest = raw.replace(/^(?:บทที่|ตอนที่|บท)\s*[0-9๐-๙]+\s*[.:–—-]?\s*/, '');
      cur = { title: rest || raw, lines: [] };
      out.push(cur);
    } else {
      if (!cur) { if (!line.trim()) continue; cur = { title: 'คำนำ', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    }
  }
  return out.map((c) => ({ title: c.title, body: c.lines.join('\n').replace(/^\s*\n|\s+$/g, '') }))
    .filter((c) => c.title && c.body.trim());
}

function bookPreview(box) {
  const b = S.ed.book.trim();
  const have = new Set(b ? chapters(b).map((x) => norm(x.title)) : []);
  const items = parseBook(S.ed.body);
  let order = b ? nextOrder(b) : 1;
  let dup = 0;
  const rows = items.map((it) => {
    const isDup = have.has(norm(it.title));
    have.add(norm(it.title));
    if (isDup) dup++;
    const no = isDup ? '–' : order++;
    const brief = it.body.replace(/\s+/g, ' ').slice(0, 110);
    return `<li class="${isDup ? 'dup' : ''}"><span class="no">${no}</span><div class="grow"><strong>${esc(it.title)}</strong>
      <p class="sub">${esc(brief)}${it.body.length > 110 ? '…' : ''} <span class="hint">(${it.body.length.toLocaleString('th-TH')} ตัวอักษร)</span></p>
      ${isDup ? '<span class="hint">มีบทชื่อนี้ในเล่มแล้ว จะข้าม</span>' : ''}</div></li>`;
  });
  box.innerHTML = items.length
    ? `<div class="bulk-sum book">${b ? `เล่ม “${esc(b)}” · ` : '<span class="err">ใส่ชื่อหนังสือด้านบนก่อน</span> · '}จะเพิ่ม <strong>${items.length - dup}</strong> บท${dup ? ` · ข้าม ${dup} ที่ซ้ำ` : ''}</div><ol class="bulklist">${rows.join('')}</ol>`
    : '<p class="hint">วางเนื้อหาแล้ว ตัวอย่างการแบ่งบทจะขึ้นตรงนี้</p>';
}

function edBulkPreview() {
  const box = document.getElementById('bulk-prev');
  if (!box || !S.ed.bulk) return;
  if (S.ed.type === 'หนังสือ') return bookPreview(box);
  const items = parseBulk(S.ed.body, S.ed.split);
  const have = new Set(S.stories.filter(isQuote).map((x) => norm(x.body)));
  let dup = 0;
  const seen = new Set();
  const rows = items.map((it, i) => {
    const k = norm(it.body);
    const isDup = have.has(k) || seen.has(k);
    seen.add(k);
    if (isDup) dup++;
    const who = it.who ? [it.who] : S.ed.speakers;
    return `<li class="${isDup ? 'dup' : ''}"><span class="no">${i + 1}</span><div class="grow"><p>${esc(it.body)}</p>
      ${who.length ? `<span class="whos">${who.map((n) => `<span class="tok who">${esc(n)}</span>`).join('')}</span>` : ''}
      ${isDup ? '<span class="hint">มีในคลังแล้ว จะข้าม</span>' : ''}</div></li>`;
  });
  const n = items.length - dup;
  box.innerHTML = items.length
    ? `<div class="bulk-sum">จะเพิ่ม <strong>${n}</strong> คำคม${dup ? ` · ข้าม ${dup} ที่ซ้ำ` : ''}</div><ol class="bulklist">${rows.join('')}</ol>`
    : '<p class="hint">วางข้อความแล้ว ตัวอย่างการแยกจะขึ้นตรงนี้</p>';
}

async function saveBookBulk() {
  const ed = S.ed;
  const btn = document.getElementById('ed-save');
  const book = ed.book.trim();
  if (!book) return toast('ใส่ชื่อหนังสือก่อน', true);
  const have = new Set(chapters(book).map((x) => norm(x.title)));
  const items = parseBook(ed.body).filter((it) => { const k = norm(it.title); if (have.has(k)) return false; have.add(k); return true; });
  if (!items.length) return toast('ไม่มีบทใหม่ให้บันทึก', true);
  btn.disabled = true;
  let done = 0;
  let order = nextOrder(book);
  try {
    for (const it of items) {
      btn.textContent = `กำลังบันทึก ${done + 1}/${items.length}…`;
      await S.api.saveStory({
        id: null, type: 'หนังสือ', title: it.title, body: it.body, highlights: [], tags: ed.tags, speakers: ed.speakers,
        source: ed.source.trim(), attachments: [], status: ed.status, book, book_order: order++,
      });
      done++;
    }
    for (const t of ed.tags) if (!S.tags.some((x) => x.name === t)) await S.api.saveTag({ name: t, synonyms: [], is_standard: false, sort: 900 });
    store.set('yom-last-type', 'หนังสือ');
    S.dirty = false;
    await refresh();
    S.view = '';
    toast(`บันทึก ${done} บทลงเล่ม “${book}” แล้ว`);
    location.hash = bookHref(book);
  } catch (err) {
    toast(done ? `บันทึกได้ ${done} จาก ${items.length} บท: ${err.message}` : err.message, true);
    if (done) {
      await refresh();
      const left = items.slice(done).map((it) => `# ${it.title}\n${it.body}`).join('\n\n');
      ed.body = left;
      document.getElementById('ed-body').value = left;
      edBulk();
    }
    btn.disabled = false;
    btn.textContent = 'บันทึกทุกบท';
  }
}

async function saveBulk() {
  const ed = S.ed;
  if (ed.type === 'หนังสือ') return saveBookBulk();
  const btn = document.getElementById('ed-save');
  const have = new Set(S.stories.filter(isQuote).map((x) => norm(x.body)));
  const items = parseBulk(ed.body, ed.split).filter((it) => {
    const k = norm(it.body);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (!items.length) return toast('ไม่มีคำคมใหม่ให้บันทึก', true);
  btn.disabled = true;
  let done = 0;
  try {
    for (const it of items) {
      btn.textContent = `กำลังบันทึก ${done + 1}/${items.length}…`;
      const base = autoTitle(it.body);
      const data = {
        id: null, type: 'คำคม', body: it.body, highlights: [], tags: ed.tags,
        speakers: it.who ? [it.who] : ed.speakers, source: ed.source.trim(), attachments: [], status: ed.status,
      };
      for (let n = 1; ; n++) {
        try { await S.api.saveStory({ ...data, title: n === 1 ? base : `${base} (${n})` }); break; }
        catch (err) { if (err.code !== 'duplicate' || n > 30) throw err; }
      }
      done++;
    }
    for (const t of ed.tags) if (!S.tags.some((x) => x.name === t)) await S.api.saveTag({ name: t, synonyms: [], is_standard: false, sort: 900 });
    store.set('yom-last-type', 'คำคม');
    S.dirty = false;
    await refresh();
    // ไปหน้าค้นหา เปิดเฉพาะคำคม
    setOff(new Set(TYPES.filter((t) => t !== 'คำคม')));
    Object.assign(S.f, { q: '', mine: 'all' });
    S.f.tags.clear(); S.f.who.clear();
    S.view = '';
    toast(`บันทึกคำคม ${done} อันแล้ว`);
    location.hash = '#/';
  } catch (err) {
    // ที่บันทึกไปแล้วเก็บไว้ ส่วนที่เหลืออยู่ในกล่องให้ลองใหม่
    toast(`บันทึกได้ ${done} จาก ${items.length} อัน: ${err.message}`, true);
    if (done) {
      const left = items.slice(done).map((it) => it.body + (it.who ? `\n— ${it.who}` : '')).join('\n\n');
      ed.body = left; ed.split = 'blank';
      document.getElementById('ed-body').value = left;
      await refresh();
      edBulk();
    }
    btn.disabled = false;
    btn.textContent = 'บันทึกคำคมทั้งหมด';
  }
}

function edType() {
  const t = S.ed.type;
  document.getElementById('ed-type').innerHTML = TYPES.map((x) =>
    `<button type="button" role="radio" class="tsel" style="${tc(x)}" data-act="ed-type" data-v="${x}" aria-pressed="${x === t}" aria-checked="${x === t}">${x}</button>`).join('');
  const optional = t === 'คำคม' || t === 'โอวาท';
  document.getElementById('title-hint').textContent = optional ? 'ไม่ใส่ก็ได้ ระบบตั้งชื่อจากข้อความให้' : '';
  document.getElementById('title-label').textContent = t === 'หนังสือ' ? 'ชื่อบท / หัวข้อ' : 'ชื่อเรื่อง';
  document.getElementById('ed').classList.toggle('book-mode', t === 'หนังสือ');
  document.getElementById('sp-label').textContent = whoLabel(t);
  edBulk();
}

// ไฮไลต์แสดงในกล่องเนื้อหาเลย: ชั้นด้านหลัง textarea วาดแถบสีตรงตำแหน่งข้อความ
function edGems() {
  const back = document.getElementById('ed-hl');
  if (!back) return;
  const live = S.ed.highlights.filter((h) => S.ed.body.includes(h));   // ที่หายจากเนื้อหาจะถูกตัดตอนบันทึก
  back.innerHTML = bodyHtml({ body: S.ed.body, highlights: live }) + '\n ';
  const n = live.length;
  document.getElementById('hl-hint').textContent = n
    ? `ไฮไลต์ไว้ ${n} ประโยค · วางเคอร์เซอร์ในข้อความที่ไฮไลต์แล้วกดปุ่ม = เอาออก`
    : 'ลากเลือกประโยคเด็ดแล้วกดปุ่ม · ประโยคที่ไฮไลต์จะขึ้นเป็นข้อความย่อบนการ์ดด้วย';
}

const tokHtml = (k, list, cls = '') => list.map((t) =>
  `<span class="tok ${cls}">${esc(t)}<button type="button" data-act="ed-rm" data-k="${k}" data-v="${esc(t)}" aria-label="เอา ${esc(t)} ออก">✕</button></span>`).join('');

function edTags() {
  const chosen = S.ed.tags;
  document.getElementById('ed-tags').innerHTML = tokHtml('tags', chosen);
  const guess = suggestTags(S.ed.body + ' ' + S.ed.title, S.tags, chosen);
  const std = S.tags.filter((t) => t.is_standard && !chosen.includes(t.name) && !guess.includes(t.name)).map((t) => t.name);
  const pill = (t, g) => `<button type="button" class="tag ${g ? 'guess' : ''}" data-act="ed-add" data-k="tags" data-v="${esc(t)}">+ ${esc(t)}</button>`;
  document.getElementById('ed-tag-sug').innerHTML =
    (guess.length ? `<span class="lab">แท็กที่น่าจะเกี่ยว</span>${guess.map((t) => pill(t, true)).join('')}<span style="flex-basis:100%"></span>` : '') +
    (std.length ? `<span class="lab">แท็กมาตรฐาน</span>${std.map((t) => pill(t)).join('')}` : '');
}

function edSpeakers() {
  const chosen = S.ed.speakers;
  edBulkPreview();
  document.getElementById('ed-sp').innerHTML = tokHtml('speakers', chosen, 'who');
  const known = countBy(S.stories, (x) => x.speakers).map(([n]) => n).filter((n) => !chosen.includes(n)).slice(0, 12);
  document.getElementById('ed-sp-sug').innerHTML = known.length
    ? `<span class="lab">เคยใส่</span>${known.map((t) => `<button type="button" class="tag who" data-act="ed-add" data-k="speakers" data-v="${esc(t)}">+ ${esc(t)}</button>`).join('')}` : '';
}

function edFiles() {
  const saved = S.ed.attachments.map((p, i) => `<div class="thumb">${isPdf(p) ? 'PDF' : `<img src="${esc(S.api.fileUrl(p))}" alt="">`}
    <button type="button" data-act="file-rm" data-v="${i}" aria-label="เอาไฟล์นี้ออก">✕</button></div>`);
  const pending = S.ed.pending.map((p, i) => `<div class="thumb">${p.file.type === 'application/pdf' ? esc(p.file.name) : `<img src="${p.url}" alt="">`}
    <button type="button" data-act="pend-rm" data-v="${i}" aria-label="เอาไฟล์นี้ออก">✕</button></div>`);
  document.getElementById('ed-files').innerHTML = [...saved, ...pending].join('');
}

function edStatus() {
  const st = S.ed.status;
  document.getElementById('ed-status').innerHTML = `
    <button type="button" role="radio" data-act="ed-status" data-v="published" aria-pressed="${st === 'published'}" aria-checked="${st === 'published'}">เผยแพร่</button>
    <button type="button" role="radio" data-act="ed-status" data-v="draft" aria-pressed="${st === 'draft'}" aria-checked="${st === 'draft'}">ร่าง</button>`;
}

function tokInput(input, key, rerender) {
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Backspace' && !input.value && S.ed[key].length) {
      S.ed[key].pop(); S.dirty = true; rerender(); return;
    }
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const v = input.value.trim();
    if (v && !S.ed[key].includes(v)) { S.ed[key].push(v); S.dirty = true; rerender(); }
    input.value = '';
  });
}

function onTabIndent(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = e.target;
  const { selectionStart: a, selectionEnd: b, value } = ta;
  const lineStart = value.lastIndexOf('\n', a - 1) + 1;
  if (e.shiftKey) {
    if (value[lineStart] === '\t') {
      ta.value = value.slice(0, lineStart) + value.slice(lineStart + 1);
      ta.selectionStart = ta.selectionEnd = Math.max(lineStart, a - 1);
    }
  } else {
    ta.value = value.slice(0, a) + '\t' + value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + 1;
  }
  ta.dispatchEvent(new Event('input'));
}

async function saveEditor(force = false) {
  const ed = S.ed;
  if (ed.bulk) {
    for (const [inp, key] of [['ed-tag-in', 'tags'], ['ed-sp-in', 'speakers']]) {
      const v = document.getElementById(inp).value.trim();
      if (v && !ed[key].includes(v)) ed[key].push(v);
    }
    return saveBulk();
  }
  const btn = document.getElementById('ed-save');
  // ข้อความที่ค้างอยู่ในช่องแท็ก/ผู้กล่าว ให้นับด้วย
  for (const [inp, key] of [['ed-tag-in', 'tags'], ['ed-sp-in', 'speakers']]) {
    const v = document.getElementById(inp).value.trim();
    if (v && !ed[key].includes(v)) ed[key].push(v);
  }
  ed.body = ed.body.replace(/\s+$/, '');
  const hasFiles = ed.attachments.length + ed.pending.length > 0;
  const needsBody = !hasFiles || ed.type === 'คำคม' || ed.type === 'โอวาท';
  if (needsBody && !ed.body.trim()) return toast('ใส่เนื้อหาก่อนบันทึก', true);
  let title = ed.title.trim();
  if (!title) {
    if (ed.type === 'คำคม' || ed.type === 'โอวาท') title = autoTitle(ed.body);
    else return toast('ใส่ชื่อเรื่องก่อนบันทึก', true);
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'กำลังบันทึก…';
  try {
    for (const p of ed.pending) ed.attachments.push(await S.api.uploadFile(await shrinkImage(p.file)));
    ed.pending = [];
    const data = {
      id: ed.id, type: ed.type, title, body: ed.body,
      highlights: ed.highlights.filter((h) => ed.body.includes(h)),
      tags: ed.tags, speakers: ed.speakers, source: ed.source.trim(), attachments: ed.attachments, status: ed.status,
    };
    // ช่องหนังสือ: ส่งเมื่อเป็นบทของหนังสือ หรือเมื่อฐานข้อมูลรองรับแล้ว (จะได้ล้างค่าเมื่อเปลี่ยนประเภท)
    const book = ed.type === 'หนังสือ' ? ed.book.trim() : '';
    if (book) { data.book = book; data.book_order = Number(ed.book_order) || nextOrder(book); }
    else if (S.bookCols) { data.book = null; data.book_order = null; }
    let saved;
    try {
      saved = await S.api.saveStory(data, { expectUpdatedAt: ed.expect, force });
    } catch (err) {
      // คำคม/โอวาทที่ตั้งชื่อเอง ถ้าชื่อชน เติม (2) (3) …
      if (err.code === 'duplicate' && !ed.title.trim()) {
        for (let n = 2; ; n++) {
          try { saved = await S.api.saveStory({ ...data, title: `${title} (${n})` }, { expectUpdatedAt: ed.expect, force }); break; }
          catch (e2) { if (e2.code !== 'duplicate' || n > 20) throw e2; }
        }
      } else throw err;
    }
    for (const t of ed.tags) if (!S.tags.some((x) => x.name === t)) await S.api.saveTag({ name: t, synonyms: [], is_standard: false, sort: 900 });
    store.set('yom-last-type', ed.type);
    S.dirty = false;
    await refresh();
    S.view = '';
    toast(saved.status === 'published' ? 'บันทึกลงคลังแล้ว โยมเห็นได้ทันที' : 'บันทึกเป็นร่างแล้ว');
    location.hash = `#/s/${encodeURIComponent(saved.id)}`;
  } catch (err) {
    if (err.code === 'duplicate' && ed.type === 'หนังสือ' && ed.book.trim()) {
      toast(`เล่มนี้มีบทชื่อ “${title}” แล้ว ตั้งชื่อบทอื่น`, true);
    } else if (err.code === 'conflict') {
      const when = err.current ? ` (แก้ล่าสุด ${thaiDate(err.current.updated_at)})` : '';
      if (confirm(`เรื่องนี้ถูกแก้จากเครื่องอื่นหลังจากคุณเปิดฟอร์ม${when}\nกด OK เพื่อบันทึกทับด้วยฉบับของคุณ หรือ Cancel เพื่อกลับไปตรวจก่อน`)) {
        btn.disabled = false; btn.textContent = label;
        return saveEditor(true);
      }
    } else {
      toast(err.message || 'บันทึกไม่สำเร็จ', true);
    }
  }
  btn.disabled = false;
  btn.textContent = label;
}

// ===================================================================== แท็ก
function viewTags() {
  S.view = 'tags';
  const counts = Object.fromEntries(countBy(S.stories, (s) => s.tags));
  app.innerHTML = shell(`<div class="page">
    <h1>แท็ก</h1>
    <p class="hint">คำใกล้เคียงช่วยให้ค้นเจอ เช่น ใส่ “ยกโทษ” ไว้ที่แท็ก “การให้อภัย” แล้วค้นคำว่ายกโทษก็เจอเรื่องในแท็กนี้ · แท็กมาตรฐานจะขึ้นเป็นตัวเลือกในหน้าเพิ่มข้อมูล</p>
    <ul class="rows">
      ${S.tags.map((t) => `<li data-tag="${esc(t.name)}">
        <div class="grow"><strong>${esc(t.name)}</strong> <span class="sub">${counts[t.name] || 0} เรื่อง</span></div>
        <input class="input wide" data-field="synonyms" value="${esc((t.synonyms || []).join(', '))}" placeholder="คำใกล้เคียง คั่นด้วยจุลภาค" aria-label="คำใกล้เคียงของ ${esc(t.name)}">
        <label class="toggle"><input type="checkbox" data-field="is_standard" ${t.is_standard ? 'checked' : ''}> มาตรฐาน</label>
        <button class="btn small" data-act="tag-save">บันทึก</button>
        <span class="slot">${counts[t.name] ? '' : '<button class="btn small danger" data-act="tag-del">ลบ</button>'}</span>
      </li>`).join('')}
      <li><div class="grow"><input class="input" id="new-tag" placeholder="ชื่อแท็กใหม่" aria-label="ชื่อแท็กใหม่"></div>
        <button class="btn primary small" data-act="tag-new">เพิ่มแท็ก</button></li>
    </ul></div>`, '#/tags');
}

// ===================================================================== ถังขยะ
async function viewTrash() {
  S.view = 'trash';
  app.innerHTML = shell('<p class="loading">กำลังโหลด…</p>', '#/trash');
  const list = await S.api.listTrash();
  if (S.view !== 'trash') return;
  app.innerHTML = shell(`<div class="page"><h1>ถังขยะ</h1>
    ${list.length ? `<ul class="rows">${list.map((s) => `<li style="${tc(s.type)}">
        <div class="grow"><span class="ttype">${s.type}</span> <strong>${esc(s.title)}</strong>
          <div class="sub">ย้ายมาเมื่อ ${thaiDate(s.deleted_at)}</div></div>
        <button class="btn small" data-act="restore" data-v="${esc(s.id)}">กู้คืน</button></li>`).join('')}</ul>`
      : '<div class="empty"><strong>ถังขยะว่าง</strong>เรื่องที่ย้ายมาที่นี่ยังกู้คืนได้เสมอ</div>'}
    </div>`, '#/trash');
}

// ===================================================================== ผู้ใช้
async function viewUsers() {
  S.view = 'users';
  app.innerHTML = shell('<p class="loading">กำลังโหลด…</p>', '#/users');
  const people = await S.api.listProfiles();
  if (S.view !== 'users') return;
  app.innerHTML = shell(`<div class="page"><h1>ผู้ใช้</h1>
    <p class="hint">คนที่จะเป็นทีมงานต้องเปิดเว็บแล้วกด “เข้าสู่ระบบ” ด้วย Google หนึ่งครั้งก่อน ชื่อจึงจะขึ้นในรายการนี้</p>
    <ul class="rows">${people.map((p) => `<li>
      <div class="grow"><strong>${esc(p.display_name || p.email)}</strong><div class="sub">${esc(p.email || '')}</div></div>
      <label class="sr-only" for="role-${esc(p.id)}">บทบาทของ ${esc(p.display_name || p.email)}</label>
      <select id="role-${esc(p.id)}" data-change="role" data-v="${esc(p.id)}" ${p.id === S.profile?.id ? 'disabled title="เปลี่ยนบทบาทตัวเองไม่ได้"' : ''}>
        ${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${p.role === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></li>`).join('')}</ul></div>`, '#/users');
}

// ===================================================================== คำสั่งจากปุ่ม
const refilter = () => { renderTagChips(); renderWhoChips(); renderMfBtn(); renderRecent(); renderResults(); };
const toggleIn = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); };

const actions = {
  async login() {
    try { await S.api.signIn('reader'); if (isDemo) { await refresh(); S.view = ''; route(); } } catch (err) { toast(err.message, true); }
  },
  async logout() {
    await S.api.signOut(); await refresh(); S.view = ''; location.hash = '#/'; route();
  },
  random() {
    const { list } = search(S.index, S.f, S.tags);
    if (list.length) location.hash = `#/s/${encodeURIComponent(list[Math.floor(Math.random() * list.length)].id)}`;
  },
  // ทั้งหมด: ถ้าเลือกครบอยู่ = ไม่เลือกเลย / ถ้ายังไม่ครบ = เลือกทั้งหมด
  tall() {
    setOff(S.f.off.size ? new Set() : new Set(TYPES));
    renderTypeSel(); renderResults();
  },
  tsel(el) {
    if (S.longPressed) { S.longPressed = false; return; }
    const off = new Set(S.f.off);
    toggleIn(off, el.dataset.v);
    setOff(off); renderTypeSel(); renderResults();
  },
  tag(el) {
    if (S.view !== 'search') { location.hash = `#/?tag=${encodeURIComponent(el.dataset.v)}`; return; }
    toggleIn(S.f.tags, el.dataset.v); refilter();
  },
  who(el) {
    if (S.view !== 'search') { location.hash = `#/?who=${encodeURIComponent(el.dataset.v)}`; return; }
    toggleIn(S.f.who, el.dataset.v); refilter();
  },
  'tag-all'() { S.f.tagAll = !S.f.tagAll; renderTagChips(); },
  'who-all'() { S.f.whoAll = !S.f.whoAll; renderWhoChips(); },
  'tag-clear'() { S.f.tags.clear(); refilter(); },
  'who-clear'() { S.f.who.clear(); refilter(); },
  mfilt() {
    S.f.mfOpen = !S.f.mfOpen;
    document.getElementById('mfilt').classList.toggle('open', S.f.mfOpen);
    document.getElementById('mfbtn').setAttribute('aria-expanded', S.f.mfOpen);
    renderMfBtn();
  },
  close() {
    if (S.stackFromApp && S.stack.length) history.go(-S.stack.length);
    else location.hash = '#/';
  },
  dback() { history.back(); },
  mine(el) { S.f.mine = el.dataset.v; renderMine(); renderResults(); },
  async fav(el) {
    const id = el.dataset.v;
    const on = !S.me.fav.has(id);
    if (on) S.me.fav.add(id); else S.me.fav.delete(id);
    document.querySelectorAll(`.fav[data-v="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute('aria-pressed', on);
      b.textContent = on ? '★' : '☆';
      b.title = b.ariaLabel = on ? 'เอาออกจากเรื่องที่ชอบ' : 'เก็บไว้ในเรื่องที่ชอบ';
    });
    if (S.view === 'search') { renderMine(); if (S.f.mine === 'fav') renderResults(); }
    toast(on ? 'เก็บไว้ใน “ที่ชอบ” แล้ว' : 'เอาออกจาก “ที่ชอบ” แล้ว');
    if (S.user) { try { await S.api.setBookmark(id, on); } catch (err) { toast(err.message, true); } } else saveLocalMe();
  },
  readtg(el) {
    const s = S.stories.find((x) => x.id === el.dataset.v);
    if (!s) return;
    if (isRead(s)) putRead(s.id, { position: 0, read_at: null });
    else putRead(s.id, { position: 100, read_at: new Date().toISOString() });
    if (S.rd) S.rd.pos = null;
    updateReadBtn(s);
    refreshCards();
  },
  goch(el) {
    const body = document.querySelector('.d-body');
    const sec = document.getElementById('ch-' + el.dataset.v);
    if (!body || !sec) return;
    body.scrollTo({ top: sec.offsetTop - 8, behavior: 'smooth' });
    if (el.classList.contains('resume')) el.remove();
  },
  resume(el) {
    const body = document.querySelector('.d-body');
    const max = body.scrollHeight - body.clientHeight;
    body.scrollTo({ top: (max * Number(el.dataset.v)) / 100, behavior: 'smooth' });
    el.remove();
  },
  font(el) {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--read'), 10) || 19;
    setRead(cur + Number(el.dataset.v));
  },

  'ed-type'(el) { S.ed.type = el.dataset.v; S.dirty = true; edType(); },
  'ed-status'(el) { S.ed.status = el.dataset.v; S.dirty = true; edStatus(); },
  'ed-bulk'(el) { S.ed.bulk = el.dataset.v === 'many'; edBulk(); },
  'ed-split'(el) { S.ed.split = el.dataset.v; store.set('yom-bulk-split', S.ed.split); edBulk(); },
  'ed-add'(el) {
    const k = el.dataset.k;
    if (!S.ed[k].includes(el.dataset.v)) S.ed[k].push(el.dataset.v);
    S.dirty = true; k === 'tags' ? edTags() : edSpeakers();
  },
  'ed-rm'(el) {
    const k = el.dataset.k;
    S.ed[k] = S.ed[k].filter((x) => x !== el.dataset.v);
    S.dirty = true; k === 'tags' ? edTags() : edSpeakers();
  },
  // เลือกข้อความแล้วกด = ไฮไลต์ · เคอร์เซอร์/ที่เลือกทับไฮไลต์เดิม = เอาออก
  'gem-add'() {
    const ta = document.getElementById('ed-body');
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const spans = [];
    for (const h of S.ed.highlights) {
      let i = value.indexOf(h);
      while (i !== -1) { spans.push({ h, a: i, b: i + h.length }); i = value.indexOf(h, i + 1); }
    }
    const hit = spans.filter((x) => (a === b ? a >= x.a && a <= x.b : a < x.b && b > x.a)).map((x) => x.h);
    if (hit.length) {
      S.ed.highlights = S.ed.highlights.filter((h) => !hit.includes(h));
      toast('เอาไฮไลต์ออกแล้ว');
    } else {
      const sel = value.slice(a, b).trim();
      if (!sel) return toast('ลากเลือกประโยคในกล่องเนื้อหาก่อน', true);
      S.ed.highlights.push(sel);
    }
    S.dirty = true; edGems();
    ta.focus();
  },
  'file-rm'(el) { S.ed.attachments.splice(Number(el.dataset.v), 1); S.dirty = true; edFiles(); },
  'pend-rm'(el) { S.ed.pending.splice(Number(el.dataset.v), 1); S.dirty = true; edFiles(); },
  async trash() {
    if (!confirm('ย้ายเรื่องนี้ไปถังขยะ? กู้คืนได้ภายหลัง')) return;
    try {
      await S.api.trashStory(S.ed.id);
      S.dirty = false; await refresh(); S.view = ''; toast('ย้ายไปถังขยะแล้ว'); location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  },
  async restore(el) {
    try { await S.api.restoreStory(el.dataset.v); await refresh(); toast('กู้คืนแล้ว'); viewTrash(); } catch (err) { toast(err.message, true); }
  },

  async 'tag-save'(el) {
    const li = el.closest('li');
    const synonyms = li.querySelector('[data-field="synonyms"]').value.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const is_standard = li.querySelector('[data-field="is_standard"]').checked;
    try { await S.api.saveTag({ name: li.dataset.tag, synonyms, is_standard }); S.tags = await S.api.listTags(); toast('บันทึกแท็กแล้ว'); } catch (err) { toast(err.message, true); }
  },
  async 'tag-del'(el) {
    const name = el.closest('li').dataset.tag;
    if (!confirm(`ลบแท็ก “${name}”?`)) return;
    try { await S.api.deleteTag(name); S.tags = await S.api.listTags(); viewTags(); toast('ลบแท็กแล้ว'); } catch (err) { toast(err.message, true); }
  },
  async 'tag-new'() {
    const name = document.getElementById('new-tag').value.trim();
    if (!name) return;
    if (S.tags.some((t) => t.name === name)) return toast('มีแท็กนี้อยู่แล้ว', true);
    try { await S.api.saveTag({ name, synonyms: [], is_standard: true, sort: 500 }); S.tags = await S.api.listTags(); viewTags(); toast('เพิ่มแท็กแล้ว'); } catch (err) { toast(err.message, true); }
  },
  async 'demo-reset'() {
    if (!confirm('ล้างข้อมูลทดลองทั้งหมดแล้วเริ่มใหม่จากตัวอย่าง?')) return;
    S.api.reset(); S.dirty = false; await refresh(); S.view = ''; location.hash = '#/'; route();
  },
};

const changes = {
  syn(el) { S.f.syn = el.checked; store.set('yom-syn', el.checked); renderResults(); },
  drafts(el) { S.f.draftsOnly = el.checked; renderResults(); },
  async role(el) {
    try { await S.api.setRole(el.dataset.v, el.value); toast('เปลี่ยนบทบาทแล้ว'); } catch (err) { toast(err.message, true); viewUsers(); }
  },
  async 'demo-role'(el) {
    if (el.value === 'guest') await S.api.signOut(); else await S.api.signIn(el.value);
    S.dirty = false; await refresh(); S.view = ''; route();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  if (el.tagName === 'BUTTON' && el.type !== 'submit') e.preventDefault();
  actions[el.dataset.act](el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e);
});

let toastTimer;
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 5000 : 2600);
}

boot();
