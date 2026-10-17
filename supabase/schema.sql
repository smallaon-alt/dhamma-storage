-- =====================================================================
-- คลังธรรมะโยม · schema สำหรับ Supabase
-- วิธีใช้: Supabase Dashboard → SQL Editor → New query → วางทั้งไฟล์ → Run
-- รันซ้ำได้ (ใช้ if not exists / or replace) แต่ถ้าแก้โครงตารางที่มีข้อมูลแล้ว ให้เขียน migration แยก
-- =====================================================================

-- ---------- ชนิดข้อมูล ----------
do $$ begin
  create type public.story_type as enum ('คำคม','เรื่องเล่า','ธรรมะ','พระไตรปิฎก','โอวาท','หนังสือ');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.user_role as enum ('reader','editor','admin');
exception when duplicate_object then null; end $$;

-- ---------- ผู้ใช้ ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  email        text,
  display_name text,
  role         public.user_role not null default 'reader',
  created_at   timestamptz not null default now()
);

-- สร้าง profile ให้อัตโนมัติเมื่อมีคนล็อกอินครั้งแรก
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ตัวช่วยตรวจบทบาท (security definer เพื่อไม่ให้ RLS วนตัวเอง)
create or replace function public.is_editor()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('editor','admin'))
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- กันไม่ให้ผู้ใช้เปลี่ยนบทบาทตัวเอง (แอดมินเปลี่ยนได้ / SQL Editor เปลี่ยนได้เพราะไม่มี auth.uid())
create or replace function public.guard_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null and not public.is_admin() then
    raise exception 'เฉพาะแอดมินเท่านั้นที่เปลี่ยนบทบาทได้';
  end if;
  if new.id = auth.uid() and old.role = 'admin' and new.role <> 'admin' then
    raise exception 'ถอดสิทธิ์แอดมินของตัวเองไม่ได้ ให้แอดมินคนอื่นทำแทน';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_role_change();

-- ---------- เนื้อหา ----------
create table if not exists public.stories (
  id          uuid primary key default gen_random_uuid(),
  type        public.story_type not null,
  title       text not null check (length(trim(title)) > 0),
  body        text not null default '',
  highlights  text[] not null default '{}',   -- ประโยคเด็ด (ข้อความที่ตรงกับในเนื้อหา)
  tags        text[] not null default '{}',
  speakers    text[] not null default '{}',   -- ผู้กล่าว / ผู้ให้โอวาท
  source      text not null default '',       -- รายละเอียดที่มา
  attachments text[] not null default '{}',   -- path ใน Storage bucket "attachments"
  status      text not null default 'draft' check (status in ('draft','published')),
  created_at  timestamptz not null default now(),  -- ใช้ทำป้าย "ใหม่"
  created_by  uuid references public.profiles default auth.uid(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles default auth.uid(),
  deleted_at  timestamptz                          -- ไม่ว่าง = อยู่ในถังขยะ
);

-- ชื่อเรื่องห้ามซ้ำ (ไม่นับเรื่องในถังขยะ)
-- ชื่อเรื่องห้ามซ้ำ (ชื่อบทซ้ำได้ถ้าอยู่คนละเล่ม) · ดู migrations/002_books.sql
alter table public.stories add column if not exists book text;
alter table public.stories add column if not exists book_order int;
do $$ begin
  alter table public.stories add constraint stories_book_check
    check (book is null or (type = 'หนังสือ' and length(trim(book)) > 0));
exception when duplicate_object then null; end $$;
drop index if exists public.stories_title_unique;
create unique index if not exists stories_title_book_unique
  on public.stories (lower(coalesce(book, '')), lower(title)) where deleted_at is null;
create index if not exists stories_book_idx
  on public.stories (book, book_order) where book is not null and deleted_at is null;
create index if not exists stories_status_idx on public.stories (status) where deleted_at is null;

create or replace function public.touch_story()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  return new;
end $$;

drop trigger if exists stories_touch on public.stories;
create trigger stories_touch
  before update on public.stories
  for each row execute function public.touch_story();

-- ---------- แท็ก ----------
create table if not exists public.tags (
  name        text primary key,
  synonyms    text[] not null default '{}',   -- คำที่ค้นแล้วให้เจอแท็กนี้ เช่น "ยกโทษ" → การให้อภัย
  is_standard boolean not null default true,  -- แสดงเป็นตัวเลือกในฟอร์มเพิ่มเรื่อง
  sort        int not null default 100
);

-- ---------- การอ่านของแต่ละคน (ใช้ในเฟส 2) ----------
create table if not exists public.reads (
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  story_id   uuid not null references public.stories on delete cascade,
  position   smallint not null default 0 check (position between 0 and 100),
  read_at    timestamptz,               -- ว่าง = ยังอ่านไม่จบ
  updated_at timestamptz not null default now(),
  primary key (user_id, story_id)
);

create table if not exists public.bookmarks (
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  story_id   uuid not null references public.stories on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, story_id)
);

-- ---------- ping กัน Supabase พักโปรเจกต์ (GitHub Actions ใน repo dhamma-backup เขียนอย่างเดียว) ----------
create table if not exists public.heartbeat (
  id        int primary key,
  pinged_at timestamptz not null default now()
);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles  enable row level security;
alter table public.stories   enable row level security;
alter table public.tags      enable row level security;
alter table public.reads     enable row level security;
alter table public.bookmarks enable row level security;
alter table public.heartbeat enable row level security;  -- ไม่มี policy = เข้าได้เฉพาะ service key

-- profiles: เห็นของตัวเอง / ผู้ดูแลเนื้อหาเห็นทุกคน / แก้ชื่อตัวเองได้ / แอดมินแก้บทบาทได้
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (id = auth.uid() or public.is_editor());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles for update
  using (public.is_admin()) with check (public.is_admin());

-- stories: ทุกคน (แม้ไม่ล็อกอิน) อ่านเรื่องที่เผยแพร่แล้ว / ผู้ดูแลเนื้อหาเห็นทุกเรื่องและเขียนได้
drop policy if exists stories_select on public.stories;
create policy stories_select on public.stories for select
  using ((status = 'published' and deleted_at is null) or public.is_editor());

drop policy if exists stories_insert on public.stories;
create policy stories_insert on public.stories for insert
  with check (public.is_editor());

drop policy if exists stories_update on public.stories;
create policy stories_update on public.stories for update
  using (public.is_editor()) with check (public.is_editor());

drop policy if exists stories_delete on public.stories;   -- ลบถาวรได้เฉพาะแอดมิน (ปกติใช้ถังขยะ)
create policy stories_delete on public.stories for delete
  using (public.is_admin());

-- tags: ทุกคนอ่าน / ผู้ดูแลเนื้อหาเขียน
drop policy if exists tags_select on public.tags;
create policy tags_select on public.tags for select using (true);

drop policy if exists tags_write on public.tags;
create policy tags_write on public.tags for all
  using (public.is_editor()) with check (public.is_editor());

-- reads / bookmarks: เจ้าของเท่านั้น
drop policy if exists reads_own on public.reads;
create policy reads_own on public.reads for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists bookmarks_own on public.bookmarks;
create policy bookmarks_own on public.bookmarks for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- =====================================================================
-- สิทธิ์ของ Data API (ปิด "Automatically expose new tables" ไว้ จึงต้องให้สิทธิ์เอง)
-- RLS ด้านบนยังเป็นตัวตัดสินว่าแต่ละแถวใครเห็น/แก้ได้
-- =====================================================================
grant usage on schema public to anon, authenticated;
grant usage on type public.story_type, public.user_role to anon, authenticated;

grant select                         on public.stories   to anon, authenticated;
grant insert, update, delete         on public.stories   to authenticated;
grant select                         on public.tags      to anon, authenticated;
grant insert, update, delete         on public.tags      to authenticated;
grant select, update                 on public.profiles  to authenticated;
grant select, insert, update, delete on public.reads     to authenticated;
grant select, insert, update, delete on public.bookmarks to authenticated;
grant all                            on public.heartbeat to service_role;

grant execute on function public.is_editor(), public.is_admin() to anon, authenticated;

-- =====================================================================
-- ไฟล์แนบ: bucket "attachments" เปิดให้อ่านสาธารณะ (รูปในเรื่องที่เผยแพร่)
-- อัปโหลด/ลบได้เฉพาะผู้ดูแลเนื้อหา · จำกัด 20 MB ต่อไฟล์ · รูปและ PDF เท่านั้น
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', true, 20971520,
        array['image/jpeg','image/png','image/webp','image/gif','application/pdf'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists attachments_editor_insert on storage.objects;
create policy attachments_editor_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'attachments' and public.is_editor());

drop policy if exists attachments_editor_update on storage.objects;
create policy attachments_editor_update on storage.objects for update to authenticated
  using (bucket_id = 'attachments' and public.is_editor());

drop policy if exists attachments_editor_delete on storage.objects;
create policy attachments_editor_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and public.is_editor());

-- =====================================================================
-- แท็กมาตรฐานตั้งต้น (แก้/เพิ่มได้ในหน้า "แท็ก" บนเว็บ)
-- =====================================================================
insert into public.tags (name, synonyms, sort) values
  ('ความหวัง',     '{กำลังใจ,ท้อแท้}',            10),
  ('ความอดทน',    '{อดทน,ขันติ}',                20),
  ('ความทุกข์',     '{ทุกข์,เศร้า,เสียใจ}',          30),
  ('การให้อภัย',    '{ยกโทษ,อภัย,ให้อภัย}',        40),
  ('ความโกรธ',     '{โกรธ,โมโห,โทสะ}',            50),
  ('คำพูด',        '{วาจา,พูดจา}',                60),
  ('การให้',       '{ทาน,แบ่งปัน}',               70),
  ('ความเสียสละ',   '{เสียสละ,จาคะ}',              80),
  ('ความกตัญญู',   '{กตัญญู,พ่อแม่}',             90),
  ('ความเมตตา',    '{เมตตา,กรุณา}',              100),
  ('ความรัก',      '{รัก}',                     110),
  ('ครอบครัว',     '{พ่อแม่,ลูก}',                120),
  ('ความตาย',     '{ตาย,ความสูญเสีย,มรณะ}',       130),
  ('ความถ่อมตน',   '{ถ่อมตน,อ่อนน้อม}',            140),
  ('ความสุข',      '{สุข,สบายใจ}',                150),
  ('ศรัทธา',       '{ความเชื่อ}',                 160),
  ('การปฏิบัติธรรม', '{นั่งสมาธิ,ภาวนา,สมาธิ}',      170)
on conflict (name) do nothing;

-- =====================================================================
-- หลังล็อกอินด้วย Google ครั้งแรก ตั้งตัวเองเป็นแอดมิน (แก้อีเมลก่อนรัน):
--   update public.profiles set role = 'admin' where email = 'อีเมลของคุณ@gmail.com';
-- =====================================================================
