const assert = require('node:assert/strict');
const test = require('node:test');
const load = () => import('../scripts/prepare-reception-import.mjs');
const header = ['卡片編號（排版用）', '卡片主標', '卡上同行姓名／稱呼', '桌次', '本組人數', '牆面分類（依來源）',
  '喜餅共領編號', '喜餅共領單位', '西式配額（共領總數）', '中式配額（共領總數）'];
const source = () => [header, ['QR001', '成哥與同行者', '成哥、攜伴', '3', 2, '親友', 'C1', '大伯家', 1, ''],
  ['QR002', '安', '安', '4', 1, '親友', 'C1', '大伯家', 1, '']];

test('匯入保留既有ID、新編號避開所有舊ID，配額按共領ID去重且空白保留', async () => {
  const { HEADERS, prepareReceptionImport } = await load();
  const existingGuestRows = [HEADERS, ['G001', '成哥'], ['G100', '已移除舊人']];
  const result = prepareReceptionImport({ qrRows: source(), existingGuestRows, receiptRows: [['id', 'guest'], ['receipt', 'G001']] });
  assert.equal(result.guests[1][0], 'G001'); assert.equal(result.guests[2][0], 'G101');
  assert.equal(result.cakeGroups.length, 2); assert.equal(result.cakeGroups[1][3], '');
  assert.equal(result.summary.people, 3); assert.equal(result.guests[1].length, 8);
  const again = prepareReceptionImport({ qrRows: source(), existingGuestRows: result.guests });
  assert.deepEqual(again.guests.map(row => row[0]), result.guests.map(row => row[0]));
});

test('匯入阻擋已被禮金引用的孤立ID、模糊舊名對應與配額衝突', async () => {
  const { HEADERS, prepareReceptionImport } = await load();
  const base = { qrRows: source(), existingGuestRows: [HEADERS, ['G001', '其他家庭']], receiptRows: [['id', 'guest'], ['receipt', 'G001']] };
  assert.throws(() => prepareReceptionImport(base), /已有紅包引用/);
  assert.throws(() => prepareReceptionImport({ ...base, legacyNames: { QR001: ['其他家庭'] },
    existingGuestRows: [HEADERS, ['G001', '其他家庭'], ['G002', '成哥']] }), /不唯一/);
  const rows = source(); rows[2][8] = 2;
  assert.throws(() => prepareReceptionImport({ ...base, qrRows: rows, receiptRows: [] }), /配額不一致/);
});
