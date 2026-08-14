const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadGateFactory() {
  const sourcePath = path.join(__dirname, '..', 'docs', 'checkin-gate.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const context = { window: {} };
  vm.runInNewContext(source + '\nthis.__testExports = window.CheckinGate;', context, { filename: sourcePath });
  return context.__testExports;
}

test('報到完成前後的 gate 只允許按下一位後再開始下一次報到', () => {
  const gate = loadGateFactory().create();

  assert.equal(gate.state(), 'READY');
  assert.equal(gate.begin(), true);
  assert.equal(gate.begin(), false);

  gate.complete();
  assert.equal(gate.state(), 'AWAITING_NEXT');
  assert.equal(gate.begin(), false);

  gate.reset();
  assert.equal(gate.state(), 'READY');
  assert.equal(gate.begin(), true);
});
test('前端設定移除站台且先載入 gate 再載入 app', () => {
  const htmlPath = path.join(__dirname, '..', 'docs', 'index.html');
  const appPath = path.join(__dirname, '..', 'docs', 'app.js');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');

  assert.equal(html.includes('id="station"'), false);
  assert.equal(app.includes('#station'), false);
  assert.ok(html.indexOf('./checkin-gate.js') < html.indexOf('./app.js'));
  assert.ok(html.includes('id="checkinModal"'));
  assert.ok(html.includes('id="nextGuestButton"'));
});