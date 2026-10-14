// ต่อ Supabase จริง · สิทธิ์ทั้งหมดถูกตรวจที่ฐานข้อมูล (RLS) ไฟล์นี้แค่ส่งคำขอ
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { uid } from './util.js';

const BUCKET = 'attachments';
const STORY_FIELDS = ['type', 'title', 'body', 'highlights', 'tags', 'speakers', 'source', 'attachments', 'status'];

export function create(url, anonKey) {
  const sb = createClient(url, anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });

  const fail = (error, fallback) => {
    if (!error) return;
    if (error.code === '23505') throw Object.assign(new Error('ชื่อเรื่องนี้มีอยู่แล้ว ตั้งชื่ออื่น'), { code: 'duplicate' });
    throw Object.assign(new Error(error.message || fallback), { code: error.code });
  };

  return {
    mode: 'supabase',

    async session() {
      const { data } = await sb.auth.getSession();
      const user = data.session?.user || null;
      if (!user) return { user: null, profile: null };
      const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
      return { user, profile: profile || { id: user.id, role: 'reader', display_name: user.email } };
    },

    onAuthChange(cb) {
      sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') cb();
      });
    },

    async signIn() {
      const redirectTo = location.origin + location.pathname;
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
      fail(error, 'เข้าสู่ระบบไม่สำเร็จ');
    },

    async signOut() {
      await sb.auth.signOut();
    },

    // ผู้อ่านได้เฉพาะเรื่องที่เผยแพร่ ผู้ดูแลเนื้อหาได้ร่างด้วย (RLS ตัดให้เอง)
    async listStories() {
      const { data, error } = await sb.from('stories').select('*').is('deleted_at', null).order('created_at', { ascending: false });
      fail(error, 'โหลดเรื่องไม่สำเร็จ');
      return data;
    },

    async listTrash() {
      const { data, error } = await sb.from('stories').select('*').not('deleted_at', 'is', null).order('deleted_at', { ascending: false });
      fail(error, 'โหลดถังขยะไม่สำเร็จ');
      return data;
    },

    // expectUpdatedAt: เวลาแก้ล่าสุดตอนเปิดฟอร์ม ถ้าไม่ตรง = มีคนแก้ทับระหว่างนั้น
    async saveStory(story, { expectUpdatedAt = null, force = false } = {}) {
      const row = Object.fromEntries(STORY_FIELDS.map((k) => [k, story[k]]));
      if (!story.id) {
        const { data, error } = await sb.from('stories').insert(row).select().single();
        fail(error, 'บันทึกไม่สำเร็จ');
        return data;
      }
      let q = sb.from('stories').update(row).eq('id', story.id);
      if (!force && expectUpdatedAt) q = q.eq('updated_at', expectUpdatedAt);
      const { data, error } = await q.select();
      fail(error, 'บันทึกไม่สำเร็จ');
      if (!data.length) {
        const { data: current } = await sb.from('stories').select('*').eq('id', story.id).maybeSingle();
        throw Object.assign(new Error('เรื่องนี้ถูกแก้จากเครื่องอื่น'), { code: 'conflict', current });
      }
      return data[0];
    },

    async trashStory(id) {
      const { error } = await sb.from('stories').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      fail(error, 'ย้ายไปถังขยะไม่สำเร็จ');
    },

    async restoreStory(id) {
      const { error } = await sb.from('stories').update({ deleted_at: null }).eq('id', id);
      fail(error, 'กู้คืนไม่สำเร็จ');
    },

    async listTags() {
      const { data, error } = await sb.from('tags').select('*').order('sort').order('name');
      fail(error, 'โหลดแท็กไม่สำเร็จ');
      return data;
    },

    async saveTag(tag) {
      const { error } = await sb.from('tags').upsert(tag);
      fail(error, 'บันทึกแท็กไม่สำเร็จ');
    },

    async deleteTag(name) {
      const { error } = await sb.from('tags').delete().eq('name', name);
      fail(error, 'ลบแท็กไม่สำเร็จ');
    },

    async uploadFile(file) {
      const now = new Date();
      const ext = (file.name.match(/\.(\w+)$/)?.[1] || 'bin').toLowerCase();
      const path = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${uid()}.${ext}`;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      fail(error, 'อัปโหลดไฟล์ไม่สำเร็จ');
      return path;
    },

    fileUrl(path) {
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },

    async listProfiles() {
      const { data, error } = await sb.from('profiles').select('*').order('created_at');
      fail(error, 'โหลดรายชื่อไม่สำเร็จ');
      return data;
    },

    // ---------- การอ่านและเรื่องที่ชอบของตัวเอง (RLS ให้เห็นเฉพาะของตัวเอง) ----------
    async listMine() {
      const [r, b] = await Promise.all([
        sb.from('reads').select('story_id,position,read_at'),
        sb.from('bookmarks').select('story_id'),
      ]);
      fail(r.error || b.error, 'โหลดสถานะการอ่านไม่สำเร็จ');
      return {
        reads: Object.fromEntries(r.data.map((x) => [x.story_id, { position: x.position, read_at: x.read_at }])),
        bookmarks: b.data.map((x) => x.story_id),
      };
    },

    async putRead(storyId, { position, read_at }) {
      const { data } = await sb.auth.getSession();
      const user_id = data.session?.user?.id;
      if (!user_id) return;
      const { error } = await sb.from('reads').upsert({
        user_id, story_id: storyId, position: Math.round(position), read_at, updated_at: new Date().toISOString(),
      });
      fail(error, 'บันทึกการอ่านไม่สำเร็จ');
    },

    async setBookmark(storyId, on) {
      const { data } = await sb.auth.getSession();
      const user_id = data.session?.user?.id;
      if (!user_id) return;
      const { error } = on
        ? await sb.from('bookmarks').upsert({ user_id, story_id: storyId })
        : await sb.from('bookmarks').delete().eq('user_id', user_id).eq('story_id', storyId);
      fail(error, 'บันทึกเรื่องที่ชอบไม่สำเร็จ');
    },

    async setRole(id, role) {
      const { error } = await sb.from('profiles').update({ role }).eq('id', id);
      fail(error, 'เปลี่ยนบทบาทไม่สำเร็จ');
    },
  };
}
