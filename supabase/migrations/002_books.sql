-- 002: หนังสือแบ่งเป็นบท
-- รันครั้งเดียวใน Supabase → SQL Editor → New query → วางทั้งไฟล์ → Run (รันซ้ำได้ ไม่เสียหาย)
--
-- แต่ละบทของหนังสือคือ 1 เรื่อง (type = 'หนังสือ') ที่บอกว่าอยู่เล่มไหน (book) และเป็นบทที่เท่าไร (book_order)
-- ชื่อบทซ้ำกันได้ถ้าอยู่คนละเล่ม เช่น "คำนำ" มีได้ทุกเล่ม

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

notify pgrst, 'reload schema';
