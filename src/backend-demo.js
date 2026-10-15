// โหมดทดลอง: ทำงานแบบเดียวกับ Supabase แต่เก็บข้อมูลไว้ในเบราว์เซอร์นี้เท่านั้น
// ใช้ลองหน้าตาและขั้นตอนก่อนต่อฐานข้อมูลจริง
import { store, uid } from './util.js';
import { demoStories, demoTags } from './demo-data.js';

const KEY = 'yom-demo-v3';
const FILES_KEY = 'yom-demo-files-v1';
const PEOPLE = [
  { id: 'demo-admin', email: 'admin@example.com', display_name: 'แอดมิน (ทดลอง)', role: 'admin' },
  { id: 'demo-editor', email: 'editor@example.com', display_name: 'ทีมงาน (ทดลอง)', role: 'editor' },
  { id: 'demo-reader', email: 'yom@example.com', display_name: 'โยม (ทดลอง)', role: 'reader' },
];

function load() {
  let db = store.get(KEY, null);
  if (!db) {
    db = { stories: demoStories(), tags: demoTags(), profiles: PEOPLE, sessionId: 'demo-admin' }; // เปิดมาเป็นแอดมิน เห็นทุกแท็บ
    store.set(KEY, db);
  }
  return db;
}

const save = (db) => store.set(KEY, db);
const clone = (x) => JSON.parse(JSON.stringify(x));

export default {
  mode: 'demo',

  async session() {
    const db = load();
    const profile = db.profiles.find((p) => p.id === db.sessionId) || null;
    return { user: profile ? { id: profile.id, email: profile.email } : null, profile };
  },

  onAuthChange() {},

  async signIn(role = 'reader') {
    const db = load();
    db.sessionId = PEOPLE.find((p) => p.role === role).id;
    save(db);
  },

  async signOut() {
    const db = load();
    db.sessionId = null;
    save(db);
  },

  async listStories() {
    const db = load();
    const me = db.profiles.find((p) => p.id === db.sessionId);
    const editor = me && me.role !== 'reader';
    return clone(db.stories.filter((s) => !s.deleted_at && (editor || s.status === 'published')))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  async listTrash() {
    return clone(load().stories.filter((s) => s.deleted_at));
  },

  async saveStory(story, { expectUpdatedAt = null, force = false } = {}) {
    const db = load();
    const now = new Date().toISOString();
    const k = (x) => `${(x.book || '').trim().toLowerCase()}|${x.title.trim().toLowerCase()}`;
    const dup = db.stories.find((s) => !s.deleted_at && s.id !== story.id && k(s) === k(story));
    if (dup) throw Object.assign(new Error('ชื่อเรื่องนี้มีอยู่แล้ว ตั้งชื่ออื่น'), { code: 'duplicate' });
    if (!story.id) {
      const row = { ...story, id: uid(), created_at: now, updated_at: now, created_by: db.sessionId, updated_by: db.sessionId, deleted_at: null };
      db.stories.push(row);
      save(db);
      return clone(row);
    }
    const i = db.stories.findIndex((s) => s.id === story.id);
    if (!force && expectUpdatedAt && db.stories[i].updated_at !== expectUpdatedAt) {
      throw Object.assign(new Error('เรื่องนี้ถูกแก้จากเครื่องอื่น'), { code: 'conflict', current: clone(db.stories[i]) });
    }
    db.stories[i] = { ...db.stories[i], ...story, updated_at: now, updated_by: db.sessionId };
    save(db);
    return clone(db.stories[i]);
  },

  async trashStory(id) {
    const db = load();
    db.stories.find((s) => s.id === id).deleted_at = new Date().toISOString();
    save(db);
  },

  async restoreStory(id) {
    const db = load();
    const s = db.stories.find((x) => x.id === id);
    if (db.stories.some((x) => !x.deleted_at && x.title === s.title && (x.book || '') === (s.book || ''))) throw new Error('ชื่อเรื่องนี้มีอยู่แล้ว ตั้งชื่ออื่น');
    s.deleted_at = null;
    save(db);
  },

  async listTags() {
    return clone(load().tags).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'th'));
  },

  async saveTag(tag) {
    const db = load();
    const i = db.tags.findIndex((t) => t.name === tag.name);
    if (i >= 0) db.tags[i] = { ...db.tags[i], ...tag };
    else db.tags.push({ synonyms: [], is_standard: true, sort: 500, ...tag });
    save(db);
  },

  async deleteTag(name) {
    const db = load();
    db.tags = db.tags.filter((t) => t.name !== name);
    save(db);
  },

  // ไฟล์ในโหมดทดลองเก็บเป็น data URL (รูปถูกย่อแล้วก่อนถึงตรงนี้)
  async uploadFile(file) {
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const files = store.get(FILES_KEY, {});
    const path = `demo/${uid()}.${(file.name.match(/\.(\w+)$/)?.[1] || 'bin').toLowerCase()}`;
    files[path] = url;
    store.set(FILES_KEY, files);
    return path;
  },

  fileUrl(path) {
    return store.get(FILES_KEY, {})[path] || '';
  },

  async listProfiles() {
    return clone(load().profiles);
  },

  async setRole(id, role) {
    const db = load();
    db.profiles.find((p) => p.id === id).role = role;
    save(db);
  },

  // สถานะการอ่านแยกตามคนที่ "ดูในฐานะ"
  async listMine() {
    const db = load();
    return clone(db.mine?.[db.sessionId] || { reads: {}, bookmarks: [] });
  },

  async putRead(storyId, { position, read_at }) {
    const db = load();
    db.mine ||= {};
    const m = (db.mine[db.sessionId] ||= { reads: {}, bookmarks: [] });
    m.reads[storyId] = { position: Math.round(position), read_at };
    save(db);
  },

  async setBookmark(storyId, on) {
    const db = load();
    db.mine ||= {};
    const m = (db.mine[db.sessionId] ||= { reads: {}, bookmarks: [] });
    m.bookmarks = m.bookmarks.filter((x) => x !== storyId);
    if (on) m.bookmarks.push(storyId);
    save(db);
  },

  reset() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(FILES_KEY);
  },
};
