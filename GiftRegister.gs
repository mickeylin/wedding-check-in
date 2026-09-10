// Keep guest data and legacy attendance separate from envelope records.
const GIFT_HEADERS = ['收件ID', '賓客ID', '顯示姓名', '紅包署名', '狀態', '金額',
  '收件人員', '收件時間', '清點人員', '清點時間', '備註', '收件請求ID',
  '撤銷人員', '撤銷時間', '撤銷請求ID'];
const GIFT_AUDIT_HEADERS = ['時間', '操作人員', '動作', '收件ID', '賓客ID', '變更內容'];

function setupGiftRegister_(ss) {
  const gifts = requireGiftSchema_(ss, 'Gifts', GIFT_HEADERS, true);
  requireGiftSchema_(ss, 'GiftAudit', GIFT_AUDIT_HEADERS, true);
  gifts.setFrozenRows(1);
  gifts.getRange('F2:F').setNumberFormat('#,##0.##');
  ['H2:H', 'J2:J', 'N2:N'].forEach(range => gifts.getRange(range).setNumberFormat('yyyy/mm/dd hh:mm:ss'));
  gifts.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['待清點', '已清點', '已撤銷'], true).setAllowInvalid(false).build());
  gifts.getRange('F2:F').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build());
  gifts.autoResizeColumns(1, GIFT_HEADERS.length);
  const dashboard = ss.getSheetByName('GiftDashboard') || ss.insertSheet('GiftDashboard');
  dashboard.getRange(1, 1, 5, 2).setValues([
    ['項目', '數值'], ['待清點包數', '=COUNTIF(Gifts!E2:E,"待清點")'],
    ['已清點包數', '=COUNTIF(Gifts!E2:E,"已清點")'],
    ['已撤銷包數', '=COUNTIF(Gifts!E2:E,"已撤銷")'],
    ['已清點金額', '=SUMIF(Gifts!E2:E,"已清點",Gifts!F2:F)']
  ]);
}

// Refuse unexpected headers instead of moving or overwriting users' money data.
function requireGiftSchema_(ss, name, headers, create) {
  let sheet = ss.getSheetByName(name);
  if (!sheet && create) sheet = ss.insertSheet(name);
  if (!sheet) throw apiError_('CONFIG_ERROR', '請先執行 setupSheet 建立 ' + name);
  if (!sheet.getLastRow() && create) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  if (headers.some((header, i) => actual[i] !== header)) {
    throw apiError_('CONFIG_ERROR', name + ' 欄位順序不符，請勿直接搬移欄位');
  }
  return sheet;
}

function giftRecord_(row, rowNumber) {
  return { rowNumber, receiptId: String(row[0] || ''), guestId: String(row[1] || '').trim(),
    displayName: String(row[2] || ''), signature: String(row[3] || ''), state: String(row[4] || ''),
    amount: row[5], receivedBy: row[6], receivedAt: row[7], countedBy: row[8], countedAt: row[9],
    notes: row[10], requestId: String(row[11] || ''), cancelledBy: row[12], cancelledAt: row[13],
    cancelRequestId: String(row[14] || '') };
}

function giftStatus_(records) {
  const active = records.filter(record => record.state !== '已撤銷');
  if (!active.length) return { giftState: '未收件', receiptId: '', canCancel: false };
  const one = active.length === 1 ? active[0] : null;
  return { giftState: active.some(record => record.state === '已清點') ? '已清點' : '待清點',
    receiptId: one ? one.receiptId : '',
    canCancel: !!one && one.state === '待清點' && one.amount === '' && !one.countedAt,
    envelopeCount: active.length };
}

function createGiftModule_(deps) {
  return {
    execute(input) {
      return deps.lock.runExclusive(() => {
        const guest = deps.guests.findById(input.guestId);
        if (!guest) throw apiError_('NOT_FOUND', '找不到賓客編號，請用姓名查找或人工處理');
        const records = deps.store.list();
        const forGuest = () => records.filter(record => record.guestId === input.guestId);
        const response = (status, message) => Object.assign({ ok: true, status, message,
          guestId: guest.guestId, displayName: guest.displayName, tableNo: guest.tableNo,
          category: guest.category }, giftStatus_(forGuest()));
        if (input.action === 'guest') return response('GUEST_FOUND', '查詢不會登記收到紅包');
        if (!input.requestId || !input.operator) throw apiError_('BAD_REQUEST', '缺少操作人員或請求編號');
        // A retry of a previous receive must not resurrect an already cancelled envelope.
        const replay = records.find(record => record.requestId === input.requestId || record.cancelRequestId === input.requestId);
        if (replay) {
          if (replay.guestId !== input.guestId) throw apiError_('BAD_REQUEST', '請求編號已使用');
          if (input.action !== 'cancel' || replay.cancelRequestId !== input.requestId || replay.state === '已撤銷') {
            return response('REPLAY', '此操作已處理，以下為目前狀態');
          }
          // A failed status write after saving cancellation metadata may be safely retried.
        }
        if (input.action === 'receive') {
          if (forGuest().some(record => record.state !== '已撤銷')) return response('ALREADY_RECEIVED', '已收紅包，未新增第二包');
          const record = { receiptId: deps.uuid(), guestId: guest.guestId, displayName: guest.displayName,
            state: '待清點', amount: '', requestId: input.requestId, receivedBy: input.operator,
            receivedAt: deps.clock() };
          deps.store.receive(record);
          records.push(record);
          return response('RECEIVED', '請在紅包寫上賓客編號 ' + guest.guestId);
        }
        if (input.action === 'cancel') {
          const record = forGuest().find(item => item.receiptId === input.receiptId);
          if (!record || !input.receiptId) throw apiError_('STALE_RECEIPT', '收件已變更，請重新查詢');
          if (record.state === '已撤銷') return response('ALREADY_CANCELLED', '這筆收件已撤銷');
          if (record.state !== '待清點' || record.amount !== '' || record.countedAt) {
            throw apiError_('COUNTED', '已清點或已填金額，請到 Google Sheet 更正');
          }
          deps.store.cancel(record, input.operator, deps.clock(), input.requestId);
          record.state = '已撤銷';
          return response('CANCELLED', '已撤銷收件，原始收件紀錄仍保留');
        }
        throw apiError_('BAD_REQUEST', '不支援的操作');
      });
    }
  };
}

function createGiftStore_(ss) {
  const sheet = requireGiftSchema_(ss, 'Gifts', GIFT_HEADERS);
  return {
    list() {
      return sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 1, sheet.getLastRow() - 1, GIFT_HEADERS.length)
        .getValues().map((row, i) => giftRecord_(row, i + 2)).filter(record => record.guestId || record.receiptId);
    },
    receive(record) {
      // The row itself durably contains the receive event, even if an audit append fails.
      sheet.appendRow([record.receiptId, sheetText_(record.guestId), sheetText_(record.displayName), '', '待清點', '',
        sheetText_(record.receivedBy), record.receivedAt, '', '', '', record.requestId, '', '', '']);
    },
    cancel(record, operator, now, requestId) {
      const current = giftRecord_(sheet.getRange(record.rowNumber, 1, 1, GIFT_HEADERS.length).getValues()[0], record.rowNumber);
      if (current.receiptId !== record.receiptId) throw apiError_('STALE_RECEIPT', '資料列已變動，請重新查詢');
      if (current.state !== '待清點' || current.amount !== '' || current.countedAt) {
        throw apiError_('COUNTED', '已清點或已填金額，請到 Google Sheet 更正');
      }
      sheet.getRange(record.rowNumber, 13, 1, 3).setValues([[sheetText_(operator), now, requestId]]);
      sheet.getRange(record.rowNumber, 5).setValue('已撤銷');
    }
  };
}

function sheetText_(value) {
  const text = String(value || '');
  return /^[=+@-]/.test(text) ? "'" + text : text;
}

function handleGiftApi_(payload, now) {
  const session = verifySessionToken_(payload.sessionToken, now);
  const ss = getSpreadsheet_();
  const lock = { runExclusive(callback) {
    return createScriptLock_(5000).runExclusive(() => {
      try { return callback(); } finally { SpreadsheetApp.flush(); }
    });
  } };
  const module = createGiftModule_({ lock, guests: createGoogleSheetsGuestStore_(ss),
    store: createGiftStore_(ss), clock: () => now, uuid: () => Utilities.getUuid() });
  return module.execute(Object.assign({}, payload, {
    guestId: extractGuestId_(payload.guestId), operator: session.operator
  }));
}

function installGiftEditTrigger() {
  const ss = getSpreadsheet_();
  const exists = ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === 'auditGiftEdit');
  if (!exists) ScriptApp.newTrigger('auditGiftEdit').forSpreadsheet(ss).onEdit().create();
  return '禮金編輯紀錄觸發器已安裝';
}

// Installable edit trigger: logs single-cell old/new values or explicitly labelled batch snapshots.
// Google does not always expose the editing account; never substitute the trigger owner's identity.
function auditGiftEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== 'Gifts') return;
  const ss = e.source;
  createScriptLock_(20000).runExclusive(() => {
    const sheet = requireGiftSchema_(ss, 'Gifts', GIFT_HEADERS);
    const audit = requireGiftSchema_(ss, 'GiftAudit', GIFT_AUDIT_HEADERS);
    const actor = e.user && e.user.getEmail() || '帳號未提供（請核對清點人員欄）';
    const now = new Date();
    const start = Math.max(2, e.range.getRow());
    const end = Math.min(sheet.getLastRow(), e.range.getLastRow());
    for (let rowNumber = start; rowNumber <= end; rowNumber++) {
      let row = sheet.getRange(rowNumber, 1, 1, GIFT_HEADERS.length).getValues()[0];
      if (!row.some(value => value !== '')) continue;
      if (!row[0]) { row[0] = Utilities.getUuid(); sheet.getRange(rowNumber, 1).setValue(row[0]); }
      if (row[4] === '已清點') {
        if (typeof row[5] !== 'number' || !isFinite(row[5]) || row[5] < 0 || !String(row[3]).trim() || !String(row[8]).trim()) {
          sheet.getRange(rowNumber, 5).setValue('待清點');
          row[4] = '待清點';
          ss.toast('已清點需填紅包署名、有效金額與清點人員；已改回待清點');
        } else if (!row[9]) {
          sheet.getRange(rowNumber, 10).setValue(now);
          row[9] = now;
        }
      }
      const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
      audit.appendRow([now, sheetText_(actor), 'SHEET_EDIT', row[0], sheetText_(row[1]), JSON.stringify({
        range: e.range.getA1Notation(), oldValue: single ? (e.oldValue === undefined ? '' : e.oldValue) : '批次編輯不提供舊值',
        newValue: single ? (e.value === undefined ? '' : e.value) : '批次編輯，見目前列快照', snapshot: row
      })]);
    }
    SpreadsheetApp.flush();
  });
}
