// Financial edits use optimistic concurrency plus a durable write-ahead audit.
// A timed-out retry resumes the same operation; it never creates a second envelope.
function countHash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8));
}

function countView_(row) {
  const record = giftRecord_(row);
  const time = value => value && typeof value.toISOString === 'function' ? value.toISOString() : String(value || '');
  return { receiptId: record.receiptId, guestId: record.guestId, displayName: record.displayName,
    signature: record.signature, state: record.state, amount: record.amount,
    receivedBy: record.receivedBy, receivedAt: time(record.receivedAt),
    countedBy: record.countedBy, countedAt: time(record.countedAt),
    notes: record.notes, envelopeCode: record.envelopeCode,
    exceptionType: record.exceptionType, version: countHash_(row) };
}

function countInput_(raw) {
  let input;
  try { input = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (err) { throw apiError_('BAD_REQUEST', '無法讀取清點內容'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError_('BAD_REQUEST', '缺少清點內容');
  const result = {};
  ['receiptId', 'version', 'guestId', 'signature', 'notes', 'reason', 'exceptionType', 'state'].forEach(key => {
    if (input[key] != null && typeof input[key] !== 'string') throw apiError_('BAD_REQUEST', '清點欄位格式不符');
    result[key] = String(input[key] || '').trim();
    if (result[key].length > (['notes', 'reason'].includes(key) ? 500 : 120)) {
      throw apiError_('BAD_REQUEST', '文字過長，署名限 120 字，備註與原因限 500 字');
    }
  });
  if (!['已清點', '待核對'].includes(result.state)) throw apiError_('BAD_REQUEST', '請選擇確認清點或待核對');
  if (input.amount != null && !['string', 'number'].includes(typeof input.amount)) {
    throw apiError_('BAD_REQUEST', '金額格式不符');
  }
  const rawAmount = input.amount == null ? '' : String(input.amount).trim();
  if (rawAmount !== '' && !/^\d{1,9}(\.\d{1,2})?$/.test(rawAmount)) {
    throw apiError_('BAD_REQUEST', '金額需為非負數，最多九位整數及兩位小數');
  }
  result.amount = rawAmount === '' ? '' : Number(rawAmount);
  if (result.state === '已清點' && (!result.signature || result.amount === '')) {
    throw apiError_('BAD_REQUEST', '確認清點需填署名與金額，未知金額請留白並選待核對');
  }
  if (result.state === '待核對' && !result.notes) throw apiError_('BAD_REQUEST', '請在備註說明待核對原因');
  if (!['', '多包', '名單外', '署名不同／代送', '無法確認'].includes(result.exceptionType)) {
    throw apiError_('BAD_REQUEST', '例外類型不符');
  }
  return result;
}

function handleCountApi_(payload, now) {
  const session = verifySessionToken_(payload.sessionToken, now);
  const ss = getSpreadsheet_();
  const sheet = requireGiftSchema_(ss, 'Gifts', GIFT_HEADERS);
  const readRows = () => sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), GIFT_HEADERS.length).getValues().slice(1);
  if (payload.action === 'countList') {
    return { ok: true, status: 'COUNT_LIST', records: readRows()
      .filter(row => row[0] && row[4] !== '已撤銷').map(countView_) };
  }
  if (payload.action !== 'countSave') throw apiError_('BAD_REQUEST', '不支援的清點操作');
  const requestId = String(payload.requestId || '');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw apiError_('BAD_REQUEST', '缺少有效請求編號');
  const input = countInput_(payload.data);
  const fingerprint = countHash_({ operator: session.operator, input });
  return createScriptLock_(20000).runExclusive(() => {
    const audit = requireGiftSchema_(ss, 'GiftAudit', GIFT_AUDIT_HEADERS);
    const auditRows = audit.getRange(1, 1, Math.max(1, audit.getLastRow()), GIFT_AUDIT_HEADERS.length).getValues();
    const operations = auditRows.map((row, index) => {
      if (!['COUNT_PENDING', 'COUNT_APPLIED'].includes(row[2])) return null;
      try { return { row: index + 1, state: row[2], entry: JSON.parse(row[5]) }; }
      catch (err) { throw apiError_('CONFIG_ERROR', '清點紀錄無法解析，請管理者檢查 GiftAudit'); }
    }).filter(Boolean);
    let op = operations.find(item => item.entry.requestId === requestId);
    let rows = readRows();
    if (op && op.entry.fingerprint !== fingerprint) throw apiError_('REQUEST_REUSED', '同一請求不可更換清點內容或人員');
    if (!op) {
      const index = input.receiptId ? rows.findIndex(row => row[0] === input.receiptId) : -1;
      const before = index >= 0 ? rows[index] : null;
      if (input.receiptId && !before) throw apiError_('CONFLICT', '紅包紀錄已變動，請重新載入');
      if (before && operations.some(item => item.state === 'COUNT_PENDING' && item.entry.after[0] === before[0])) {
        throw apiError_('BUSY', '這包紅包仍有待確認的清點，請原操作人員重試');
      }
      if (before && (before[4] === '已撤銷' || countHash_(before) !== input.version)) {
        throw apiError_('CONFLICT', '另一人已修改這包紅包，請重新載入最新資料並核對');
      }
      if (before && before[4] === '已清點' && !input.reason) throw apiError_('BAD_REQUEST', '更正已清點資料需填原因');
      if (before && input.exceptionType === '多包' && before[16] !== '多包') {
        throw apiError_('BAD_REQUEST', '第二包請使用例外狀況新增紅包，勿改寫目前這包');
      }
      let after = before ? before.slice() : Array(GIFT_HEADERS.length).fill('');
      if (before && input.guestId !== String(before[1] || '')) {
        if (before[1]) throw apiError_('BAD_REQUEST', '已有賓客關聯不可直接更換，請管理者核對');
        if (input.guestId) {
          const matches = requireGiftSchema_(ss, 'Guests', GUEST_HEADERS).getDataRange().getValues().slice(1)
            .filter(row => String(row[0]).toLowerCase() === input.guestId.toLowerCase());
          if (matches.length !== 1) throw apiError_('BAD_REQUEST', '找不到唯一賓客編號');
          after[1] = String(matches[0][0]); after[2] = String(matches[0][1]);
        }
      }
      if (!before) {
        if (!input.exceptionType) throw apiError_('BAD_REQUEST', '新增紅包需選例外類型');
        if (input.exceptionType === '多包' && !input.guestId) throw apiError_('BAD_REQUEST', '第二包需填原賓客編號');
        let guest = null;
        if (input.guestId) {
          const guestSheet = requireGiftSchema_(ss, 'Guests', GUEST_HEADERS);
          const matches = guestSheet.getDataRange().getValues().slice(1)
            .filter(row => String(row[0]).toLowerCase() === input.guestId.toLowerCase());
          if (matches.length !== 1) throw apiError_('BAD_REQUEST', '找不到唯一賓客編號，請先確認名單');
          guest = guestRecordFromRow_(matches[0]);
        }
        if (input.exceptionType === '多包' && !rows.some(row => row[1] === guest.guestId && row[4] !== '已撤銷')) {
          throw apiError_('BAD_REQUEST', '此賓客尚無第一包收件，請先從接待收件登記');
        }
        // Include reserved codes from unfinished audit operations; never reuse a bag number.
        const codes = rows.map(row => row[15]).concat(operations.map(item => item.entry.after[15]));
        const sequence = codes.reduce((max, code) => /^E\d+$/.test(String(code)) ? Math.max(max, Number(String(code).slice(1))) : max, 0) + 1;
        after[0] = Utilities.getUuid();
        after[1] = guest ? guest.guestId : '';
        after[2] = guest ? guest.displayName : input.signature || '待確認送禮人';
        after[6] = session.operator;
        after[7] = now.toISOString();
        after[11] = requestId;
        after[15] = 'E' + String(sequence).padStart(3, '0');
      }
      after[3] = input.signature;
      after[4] = input.state;
      after[5] = input.amount;
      after[8] = session.operator;
      after[9] = now.toISOString();
      after[10] = input.notes;
      after[16] = input.exceptionType;
      // Normalize dates before persisting the audit, so replay comparisons are stable.
      const entry = JSON.parse(JSON.stringify({ requestId, fingerprint, before, after, reason: input.reason }));
      audit.appendRow([now, sheetText_(session.operator), 'COUNT_PENDING', after[0], sheetText_(after[1]), JSON.stringify(entry)]);
      SpreadsheetApp.flush();
      op = { row: audit.getLastRow(), state: 'COUNT_PENDING', entry };
    }
    const entry = op.entry;
    // Re-read after persisting the audit intent: a direct Sheet edit can bypass
    // the script lock. This narrows the race but Sheets is not transactional.
    rows = readRows();
    let index = rows.findIndex(row => row[0] === entry.after[0]);
    let current = index >= 0 ? rows[index] : null;
    if (op.state === 'COUNT_APPLIED') {
      if (!current) throw apiError_('RECOVERY_CONFLICT', '清點已處理但紅包列被移除，請管理者核對帳本');
      return { ok: true, status: 'COUNT_REPLAY', record: countView_(current) };
    }
    // Another direct Sheet edit must never be overwritten during recovery.
    if (countHash_(current) !== countHash_(entry.after)) {
      if (countHash_(current) !== countHash_(entry.before)) {
        throw apiError_('RECOVERY_CONFLICT', '儲存中途資料被修改，請管理者依 GiftAudit 核對；請勿新增另一包');
      }
      const safe = entry.after.map((value, column) => {
        if ([7, 9, 13].includes(column) && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(String(value))) return new Date(value);
        return typeof value === 'string' ? sheetText_(value) : value;
      });
      if (index < 0) { sheet.appendRow(safe); index = sheet.getLastRow() - 2; }
      else sheet.getRange(index + 2, 1, 1, GIFT_HEADERS.length).setValues([safe]);
      SpreadsheetApp.flush();
    }
    audit.getRange(op.row, 3).setValue('COUNT_APPLIED');
    SpreadsheetApp.flush();
    current = sheet.getRange(index + 2, 1, 1, GIFT_HEADERS.length).getValues()[0];
    return { ok: true, status: 'COUNT_SAVED', record: countView_(current) };
  });
}
