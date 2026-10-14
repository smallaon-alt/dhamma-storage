# คลังธรรมะโยม

เว็บคลังธรรมะสำหรับโยม หน้าตาและวิธีใช้อิงแอปคลังเทศน์ แต่ระบบและข้อมูลแยกขาดจากกัน
ทีมงานและพระเพิ่มเรื่องผ่านหน้าเว็บ ข้อมูลทั้งหมดอยู่ใน Supabase (แผนฟรี)

สถานะ: **เฟส 1** (ฐานข้อมูล, ล็อกอิน, หน้าเพิ่มข้อมูล, หน้าค้นหาและอ่าน, ping + backup ด้วย GitHub Actions)
ใช้บริการ: Supabase (ข้อมูล) · GitHub Pages (หน้าเว็บ) · GitHub Actions (ping + backup) · Google (ล็อกอิน) ฟรีทั้งหมด
เฟส 2 จะเพิ่ม: อ่านแล้ว ✓, ป้าย "ใหม่", อ่านถึงไหน, บุ๊กมาร์ก (ตารางในฐานข้อมูลเตรียมไว้แล้ว)

## โครงไฟล์

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `index.html` | หน้าเว็บ (ไม่ต้อง build) |
| `config.js` | ที่ใส่ URL และ anon key ของ Supabase · เว้นว่าง = โหมดทดลอง |
| `src/app.js` | หน้าค้นหา อ่าน เพิ่ม/แก้ไข แท็ก ถังขยะ ผู้ใช้ |
| `src/search.js` | ค้นหาภาษาไทย + คำพ้อง |
| `src/backend-supabase.js` | คุยกับ Supabase จริง |
| `src/backend-demo.js`, `src/demo-data.js` | โหมดทดลอง ข้อมูลตัวอย่างเก็บในเบราว์เซอร์ |
| `src/styles.css` | สีและหน้าตา |
| `supabase/schema.sql` | ตาราง สิทธิ์ (RLS) และที่เก็บไฟล์แนบ |
| `privacy.html` | นโยบายความเป็นส่วนตัว (Google ต้องใช้ตอน Publish app) |
| `backup-repo/` | ไฟล์สำหรับ repo backup แบบ private: ping กันพัก + สำรองข้อมูล |

## 1. ลองดูในเครื่อง (โหมดทดลอง)

เปิดไฟล์ `index.html` ตรง ๆ ไม่ได้ ต้องเปิดผ่านเว็บเซิร์ฟเวอร์เล็ก ๆ:

```bash
cd ~/คลังธรรมะโยม
python3 -m http.server 8000
```

แล้วเปิด http://localhost:8000 · แถบดำด้านบนเลือก "ดูในฐานะ" โยม / ผู้ดูแลเนื้อหา / แอดมิน ได้
ข้อมูลที่ลองเพิ่มเก็บในเบราว์เซอร์นั้นเท่านั้น กด "ล้างข้อมูลทดลอง" เพื่อเริ่มใหม่

## 2. ต่อ Supabase

1. **สร้างตาราง**: Supabase → SQL Editor → New query → วางทั้งไฟล์ `supabase/schema.sql` → Run
2. **เปิด Google login**
   - Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
   - นำ Client ID / Secret ไปใส่ที่ Supabase → Authentication → Sign In / Providers → Google
3. **ตั้งที่อยู่เว็บ**: Supabase → Authentication → URL Configuration
   - Site URL: ที่อยู่เว็บจริง เช่น `https://khlang-yom.pages.dev`
   - Redirect URLs: เพิ่ม `http://localhost:8000` และที่อยู่เว็บจริง
4. **ใส่คีย์**: Supabase → Project Settings → API → คัดลอก Project URL และ anon/publishable key ใส่ใน `config.js`
   (ห้ามใช้ service_role / secret key ในเว็บ)
5. **ตั้งแอดมินคนแรก**: เปิดเว็บ กดเข้าสู่ระบบด้วย Google หนึ่งครั้ง แล้วรันใน SQL Editor:
   ```sql
   update public.profiles set role = 'admin' where email = 'อีเมลของคุณ@gmail.com';
   ```
   หลังจากนั้นตั้งทีมงานเป็น "ผู้ดูแลเนื้อหา" ได้จากหน้า **ผู้ใช้** บนเว็บ

## 3. ขึ้นเว็บด้วย GitHub Pages (ฟรี)

1. GitHub → **New repository** → ชื่อ `khlang-yom` → **Public** → Create
2. ในหน้า repo กด **uploading an existing file** → ลากไฟล์และโฟลเดอร์เหล่านี้ไปวาง:
   `index.html`, `config.js`, `privacy.html`, `README.md`, โฟลเดอร์ `src` และ `supabase`
   (ไม่ต้องอัปโหลด `backup-repo`) → **Commit changes**
3. Settings → **Pages** → Source: Deploy from a branch → Branch: `main` / `(root)` → Save
   รอ 1–2 นาที จะได้ที่อยู่ `https://<ชื่อบัญชี>.github.io/khlang-yom/`
4. นำที่อยู่นี้ไปเพิ่มใน
   - Supabase → Authentication → URL Configuration: Site URL = ที่อยู่เว็บ และ Redirect URLs เพิ่ม `https://<ชื่อบัญชี>.github.io/khlang-yom/**`
   - Google Cloud → Clients → Authorized JavaScript origins เพิ่ม `https://<ชื่อบัญชี>.github.io`
   - Google Cloud → Branding: Home page = ที่อยู่เว็บ, Privacy policy = ที่อยู่เว็บ + `privacy.html` แล้วกด **Publish app**

**แก้เว็บภายหลัง**: เปิดไฟล์ใน repo บนเว็บ GitHub → ไอคอนดินสอ → แก้ → Commit · หน้าเว็บอัปเดตเองใน 1–2 นาที

## 4. ping + สำรองข้อมูล (GitHub Actions)

ต้องทำทันทีหลังสร้างโปรเจกต์ Supabase เพราะแผนฟรีจะพักโปรเจกต์ที่เงียบเกิน 7 วัน
และถ้าถูกพัก **เว็บจะอ่านไม่ได้เลย**

1. GitHub → New repository → ชื่อ `khlang-yom-backup` → **Private** → ติ๊ก Add a README → Create
2. **Add file → Create new file** → ช่องชื่อพิมพ์ `.github/workflows/keepalive-backup.yml`
   → วางเนื้อหาจากไฟล์ `backup-repo/keepalive-backup.yml` → Commit
3. Settings → **Secrets and variables → Actions**
   - แท็บ Variables → New repository variable: `SUPABASE_URL` = `https://xxxx.supabase.co`
   - แท็บ Secrets → New repository secret: `SUPABASE_SECRET_KEY` = คีย์ `sb_secret_…` จาก Supabase → Settings → API Keys
4. ทดสอบ: แท็บ **Actions** → keepalive-and-backup → **Run workflow** → เลือก `backup` → Run
   ผ่านแล้วจะเห็นเครื่องหมาย ✓ สีเขียว และ repo มีโฟลเดอร์ `backups/วันที่/`
   ถ้าทำงานไม่สำเร็จในอนาคต GitHub จะส่งอีเมลแจ้งเจ้าของ repo

**กู้ข้อมูล**: ไฟล์ JSON ใน `backups/วันที่/` นำเข้ากลับด้วย Supabase → Table Editor → Import data หรือให้ผู้ช่วยเขียนสคริปต์นำเข้า

## หลักสิทธิ์ (ตรวจที่ฐานข้อมูลทุกคำขอ)

| บทบาท | ทำอะไรได้ |
| --- | --- |
| ยังไม่ล็อกอิน | ค้นหาและอ่านเรื่องที่เผยแพร่แล้ว |
| โยม (reader) | เหมือนด้านบน + (เฟส 2) บันทึกการอ่านและบุ๊กมาร์กของตัวเอง |
| ผู้ดูแลเนื้อหา (editor) | + เห็นร่าง เพิ่ม แก้ ย้ายไปถังขยะ กู้คืน แนบไฟล์ จัดการแท็ก |
| แอดมิน (admin) | + ตั้งบทบาทผู้ใช้ ลบเรื่องถาวร |
