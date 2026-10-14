// ใส่ค่าจาก Supabase Dashboard → Project Settings → API
// - SUPABASE_URL      = Project URL
// - SUPABASE_ANON_KEY = anon / publishable key (คีย์นี้เปิดเผยได้ สิทธิ์จริงคุมด้วย RLS ในฐานข้อมูล)
// ห้ามใส่ service_role / secret key ในไฟล์นี้เด็ดขาด
//
// ถ้าเว้นว่างทั้งสองค่า เว็บจะเปิดใน "โหมดทดลอง" ใช้ข้อมูลตัวอย่างที่เก็บในเบราว์เซอร์

export const SUPABASE_URL = 'https://jeblhgylurejhqwenvch.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_IlOpDNJ8b2W2hL2jKKZlcQ_baUum4nH';
