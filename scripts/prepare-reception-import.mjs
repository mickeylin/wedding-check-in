// Pure, reviewable transformation. This module never writes to Google Sheets.
export const HEADERS = ['賓客ID', '顯示姓名', '新郎/新娘方', '桌號', '備註', '同行姓名', '人數', '喜餅共領ID'];
export const CAKE_HEADERS = ['喜餅共領ID', '共領名稱', '西式配額', '中式配額'];
const normalize = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();
const number = value => {
  if (value === '' || value == null) return '';
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('人數／配額不是非負整數');
  return result;
};

export function prepareReceptionImport({ qrRows, existingGuestRows, receiptRows = [], legacyNames = {}, existingCakeRows = [] }) {
  const expected = ['卡片編號（排版用）', '卡片主標', '卡上同行姓名／稱呼', '桌次', '本組人數', '牆面分類（依來源）',
    '喜餅共領編號', '喜餅共領單位', '西式配額（共領總數）', '中式配額（共領總數）'];
  if (expected.some((header, i) => qrRows[0]?.[i] !== header)) throw new Error('QR來源欄位不符');
  if (HEADERS.slice(0, 5).some((header, i) => existingGuestRows[0]?.[i] !== header)) throw new Error('既有Guests欄位不符');
  const old = existingGuestRows.slice(1).filter(row => row[0]);
  const used = new Set(old.map(row => String(row[0])));
  if (used.size !== old.length) throw new Error('既有賓客ID重複');
  const claimed = new Set(), cakes = new Map(), cards = new Set(), mapping = [];
  let sequence = old.reduce((max, row) => /^G\d+$/i.test(row[0]) ? Math.max(max, Number(row[0].slice(1))) : max, 0) + 1;
  const guests = qrRows.slice(1).filter(row => row[0]).map(row => {
    const [card, title, members, table, size, category, cakeId, cakeName, western, chinese] = row;
    if (!title || !members || !cakeId || !cakeName || !table || !category || number(size) < 1) throw new Error('來源缺少必要資料：' + card);
    if (cards.has(card)) throw new Error('卡片編號重複');
    cards.add(card);
    const representative = String(title).split('（')[0].replace(/與同行者$/, '').trim();
    const names = [representative, String(title).replace(/與同行者$/, ''), ...(legacyNames[card] || [])].map(normalize);
    const matches = old.filter(item => names.includes(normalize(item[1])));
    if (matches.length > 1) throw new Error('舊名單對應不唯一：' + card);
    let id = matches[0]?.[0];
    if (!id) { while (used.has('G' + String(sequence).padStart(3, '0'))) sequence++;
      id = 'G' + String(sequence++).padStart(3, '0'); used.add(id); }
    if (claimed.has(id)) throw new Error('兩張卡不可使用同一賓客ID：' + id);
    claimed.add(id);
    const cake = [cakeId, cakeName, number(western), number(chinese)];
    if (cakes.has(cakeId) && JSON.stringify(cakes.get(cakeId)) !== JSON.stringify(cake)) throw new Error('同共領ID配額不一致');
    const existing = existingCakeRows.slice(1).find(item => item[0] === cakeId);
    if (existing && existing[1] !== cakeName) throw new Error('喜餅共領ID已用於另一家庭，不能重配');
    cakes.set(cakeId, cake);
    mapping.push({ card, id, name: representative });
    // Notes needed at the desk are retained; source URLs and bookkeeping columns
    // belong to the source list rather than the operational guest master.
    const notes = String(row[12] || '');
    const oldName = matches[0]?.[1];
    const searchableMembers = oldName && !normalize(members).includes(normalize(oldName)) && oldName !== '朱育揚'
      ? members + '；其他稱呼：' + oldName : members;
    return [id, String(title).replace(/與同行者$/, ''), category, String(table), notes, searchableMembers, number(size), cakeId];
  });
  const referenced = new Set(receiptRows.slice(1).filter(row => row[0] && row[1]).map(row => String(row[1])));
  const missing = [...referenced].filter(id => !claimed.has(id));
  if (missing.length) throw new Error('已有紅包引用的ID未對應到新名單：' + missing.join('、'));
  return { guests: [HEADERS, ...guests], cakeGroups: [CAKE_HEADERS, ...cakes.values()], mapping,
    removedIds: old.filter(row => !claimed.has(row[0])).map(row => row[0]),
    summary: { cards: guests.length, people: guests.reduce((sum, row) => sum + row[6], 0), cakeGroups: cakes.size } };
}
