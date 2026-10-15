// ค้นหาภาษาไทยในเบราว์เซอร์ · แนวเดียวกับแอปคลังเทศน์
// - พิมพ์หลายคำเว้นวรรค = ต้องมีครบทุกคำ
// - ค้นคำใกล้เคียงผ่านคำพ้องของแท็ก เช่น "ยกโทษ" เจอเรื่องที่ติดแท็ก "การให้อภัย"

import { esc } from './util.js';

const wordSeg = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('th', { granularity: 'word' }) : null;

export const norm = (s) => (s || '').toString().normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

export function buildIndex(stories) {
  return stories.map((s) => ({
    s,
    title: norm(s.title),
    body: norm(s.body),
    tags: s.tags.map(norm),
    speakers: s.speakers.map(norm),
    source: norm(s.source),
    book: norm(s.book),
  }));
}

// คำค้น → แท็กที่เกี่ยวข้อง (ชื่อแท็กหรือคำพ้องมีคำนี้)
export function synonymTags(term, tags) {
  const t = norm(term);
  if (!t) return [];
  return tags
    .filter((tag) => norm(tag.name).includes(t) || (tag.synonyms || []).some((w) => norm(w).includes(t) || t.includes(norm(w))))
    .map((tag) => norm(tag.name));
}

// ตัวกรองแบบแอปคลังเทศน์:
//   off  = ประเภทที่ซ่อนอยู่ · tags = ต้องมีครบทุกแท็กที่เลือก · who = ของผู้กล่าวคนใดคนหนึ่งที่เลือก
//   syn  = ค้นคำใกล้เคียงด้วย (คำพ้องของแท็ก)
// คืน { list, extra } โดย extra = แท็กที่ถูกดึงมาเพราะคำใกล้เคียง (ไว้บอกผู้ใช้)
export function search(index, { q = '', off = new Set(), tags = new Set(), who = new Set(), draftsOnly = false, syn = true }, tagList = []) {
  const terms = norm(q).split(' ').filter(Boolean);
  const termTags = terms.map((t) => (syn ? synonymTags(t, tagList) : []));
  const wantTags = [...tags].map(norm);
  const wantWho = [...who].map(norm);
  const out = [];
  const used = new Set();
  for (const e of index) {
    if (off.has(e.s.type)) continue;
    if (wantTags.some((t) => !e.tags.includes(t))) continue;
    if (wantWho.length && !wantWho.some((w) => e.speakers.includes(w))) continue;
    if (draftsOnly && e.s.status !== 'draft') continue;
    let score = 0;
    let ok = true;
    terms.forEach((t, i) => {
      const inTitle = e.title.includes(t);
      const viaSyn = termTags[i].filter((x) => e.tags.includes(x));
      const inTags = e.tags.some((x) => x.includes(t)) || viaSyn.length > 0;
      viaSyn.forEach((x) => { if (!x.includes(t)) used.add(x); });
      const inSpeaker = e.speakers.some((x) => x.includes(t));
      const inSource = e.source.includes(t) || e.book.includes(t);
      const bodyHits = countHits(e.body, t);
      if (!inTitle && !inTags && !inSpeaker && !inSource && !bodyHits) { ok = false; return; }
      score += (inTitle ? 10 : 0) + (inTags ? 6 : 0) + (inSpeaker ? 4 : 0) + (inSource ? 2 : 0) + Math.min(bodyHits, 5);
    });
    if (ok) out.push({ s: e.s, score });
  }
  if (terms.length) out.sort((a, b) => b.score - a.score || cmpDate(a.s, b.s));
  else out.sort((a, b) => cmpDate(a.s, b.s));
  return { list: out.map((x) => x.s), extra: [...used] };
}

const cmpDate = (a, b) => (b.created_at || '').localeCompare(a.created_at || '');

function countHits(hay, t) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(t, i)) !== -1) { n++; i += t.length; }
  return n;
}

// ข้อความย่อบนการ์ด: ถ้าพิมพ์ค้น แสดงช่วงที่ตรงคำค้น / ถ้ามีประโยคเด็ด แสดงประโยคเด็ด / ไม่งั้นต้นเรื่อง
export function excerptHtml(story, q) {
  const terms = norm(q).split(' ').filter(Boolean);
  const body = (story.body || '').replace(/\s+/g, ' ').trim();
  if (terms.length) {
    const low = body.toLowerCase();
    const hit = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    if (hit !== undefined) {
      const start = snapStart(body, Math.max(0, hit - 30));
      const piece = (start > 0 ? '…' : '') + body.slice(start, start + 140);
      return markTerms(piece, terms);
    }
  }
  if (story.highlights?.length) return story.highlights.map((h) => `<mark>${esc(h)}</mark>`).join(' ');
  return esc(body.length > 420 ? body.slice(0, 420) + '…' : body);
}

function snapStart(text, i) {
  if (!wordSeg || i === 0) return i;
  for (const seg of wordSeg.segment(text.slice(Math.max(0, i - 20), i + 20))) {
    const pos = Math.max(0, i - 20) + seg.index;
    if (pos >= i) return pos;
  }
  return i;
}

export function markTerms(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(escapeRe(esc(t)), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ตั้งชื่อคำคมจากข้อความ: ตัดที่ขอบคำ ไม่เกิน ~40 ตัวอักษร
export function autoTitle(text, max = 40) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  if (!wordSeg) return clean.slice(0, max) + '…';
  let out = '';
  for (const seg of wordSeg.segment(clean)) {
    if ((out + seg.segment).length > max) break;
    out += seg.segment;
  }
  return out.trim() + '…';
}

// แท็กที่น่าจะเกี่ยว: แท็กที่ชื่อหรือคำพ้องปรากฏในเนื้อหา
export function suggestTags(text, tags, chosen = []) {
  const hay = norm(text);
  if (!hay) return [];
  return tags
    .filter((t) => !chosen.includes(t.name))
    .filter((t) => [t.name, ...(t.synonyms || [])].some((w) => norm(w).length > 1 && hay.includes(norm(w))))
    .map((t) => t.name)
    .slice(0, 8);
}
