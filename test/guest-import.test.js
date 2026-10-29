const test = require('node:test');
const assert = require('node:assert/strict');

async function moduleUnderTest() {
  return import('../scripts/prepare-guest-import.mjs');
}

test('轉成新版 Guests 五欄、保留完整分類與備註，排除不參加', async () => {
  const { prepareGuestImport, GUEST_HEADERS } = await moduleUnderTest();
  const source = [
    'Name,人數,分類,喜餅,確認,素食,備註',
    '王大明闔府,3,男方家人,1,會參加,No,"帶小孩, 靠走道"',
    '陳小美,0,女方朋友,1,不參加,No,',
  ].join('\r\n');
  const result = prepareGuestImport(source);

  assert.deepEqual(result.rows[0], GUEST_HEADERS);
  assert.deepEqual(result.rows[1], ['', '王大明闔府', '男方家人', '', '帶小孩, 靠走道']);
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.guestRows, 1);
  assert.equal(result.summary.excludedNotAttending, 1);
  assert.deepEqual(result.summary.confirmations, { 會參加: 1, 不參加: 1 });
});

test('空白與待回覆仍保留，避免漏掉可能託人送禮者', async () => {
  const { prepareGuestImport } = await moduleUnderTest();
  const source = [
    'Name,人數,分類,喜餅,確認,素食,備註',
    '待確認朋友,,共同朋友,0,,No,',
    '尚未回覆朋友,0,女方朋友,0,！待回復！,No,',
  ].join('\n');
  const result = prepareGuestImport(source);

  assert.equal(result.summary.guestRows, 2);
  assert.equal(result.summary.excludedNotAttending, 0);
});

test('支援引號內換行並防止試算表公式注入', async () => {
  const { prepareGuestImport } = await moduleUnderTest();
  const source = [
    'Name,人數,分類,喜餅,確認,素食,備註',
    '"=IMPORTXML(\"\"x\"\")",1,共同朋友,0,會參加,No,"第一行',
    '第二行"',
  ].join('\n');
  const result = prepareGuestImport(source);

  assert.equal(result.rows[1][1], "'=IMPORTXML(\"x\")");
  assert.equal(result.rows[1][4], '第一行\n第二行');
});

test('缺少來源欄位時拒絕產生', async () => {
  const { prepareGuestImport } = await moduleUnderTest();
  assert.throws(
    () => prepareGuestImport('Name,分類,備註\n王大明,男方朋友,'),
    /CSV 缺少欄位：人數、喜餅、確認、素食/,
  );
});

test('輸出 UTF-8 BOM 並正確跳脫 CSV', async () => {
  const { serializeCsv } = await moduleUnderTest();
  const output = serializeCsv([['顯示姓名', '備註'], ['王大明', '有逗號,也有"引號"']]);
  assert.ok(output.startsWith('\uFEFF'));
  assert.match(output, /"有逗號,也有""引號"""/);
});
