export const TYPES = ['คำคม', 'เรื่องเล่า', 'ธรรมะ', 'พระไตรปิฎก', 'โอวาท', 'หนังสือ'];
export const typeClass = (type) => 't' + (TYPES.indexOf(type) + 1);

export const ROLE_LABEL = { reader: 'โยม', editor: 'ผู้ดูแลเนื้อหา', admin: 'แอดมิน' };

export function esc(s) {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// วันที่แบบไทย เช่น 14 ต.ค. 69
export function thaiDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: '2-digit' });
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* โหมดส่วนตัว / พื้นที่เต็ม */ }
  },
};

// ย่อรูปก่อนอัปโหลด: ด้านยาวสุด 1600px, JPEG คุณภาพ 0.85 · PDF และ GIF ส่งตามเดิม
export async function shrinkImage(file, max = 1600) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export const isPdf = (path) => /\.pdf$/i.test(path);
