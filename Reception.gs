// Guest cards and cake entitlements are separate identities. Cake issues are
// online, append-only operations; unlike envelope receipts they must not be
// accepted from an offline snapshot.
const CAKE_GROUP_HEADERS = ['喜餅共領ID', '共領名稱', '西式配額', '中式配額'];
const CAKE_LOG_HEADERS = ['發放ID', '喜餅共領ID', '賓客ID', '動作', '西式盒數', '中式盒數',
  '操作人員', '時間', '請求ID', '原發放ID', '原因'];

function setupReception_(ss) {
  const guests = getRequiredSheet_(ss, 'Guests');
  const headers = guests.getRange(1, 1, 1, 8).getValues()[0];
  RECEPTION_GUEST_HEADERS.slice(5).forEach((header, offset) => {
    if (headers[offset + 5] && headers[offset + 5] !== header) {
      throw apiError_('CONFIG_ERROR', 'Guests F:H 有其他欄位，請先備份及移開後再初始化');
    }
  });
  guests.getRange(1, 6, 1, 3).setValues([RECEPTION_GUEST_HEADERS.slice(5)]);
  requireGiftSchema_(ss, 'CakeGroups', CAKE_GROUP_HEADERS, true).setFrozenRows(1);
  requireGiftSchema_(ss, 'CakeLog', CAKE_LOG_HEADERS, true).setFrozenRows(1);
  safeCacheRemove_(GIFT_GUEST_CACHE_KEY);
}

function cakeQuota_(value) {
  if (value === '' || value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw apiError_('CONFIG_ERROR', '喜餅配額需為非負整數；未知請留白');
  }
  return value;
}

function cakeRecords_(rows) {
  return rows.filter(row => row.some(value => value !== '')).map(row => ({
    id: String(row[0]), groupId: String(row[1]), guestId: String(row[2]), action: String(row[3]),
    western: row[4], chinese: row[5], operator: String(row[6]),
    at: row[7] instanceof Date ? row[7].toISOString() : String(row[7]),
    requestId: String(row[8]), originalId: String(row[9] || ''), reason: String(row[10] || '')
  }));
}

// Read and validate a bounded table in one values request, rather than reading
// its header separately and then loading the same cells again.
function readCakeRows_(sheet, headers) {
  const values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), headers.length).getValues();
  if (headers.some((header, i) => values[0][i] !== header)) {
    throw apiError_('CONFIG_ERROR', sheet.getName() + ' 欄位順序不符');
  }
  return values.slice(1);
}

function createCakeSnapshot_(ss) {
  const groups = readCakeRows_(getRequiredSheet_(ss, 'CakeGroups'), CAKE_GROUP_HEADERS)
    .filter(row => row[0]).map(row => ({ id: String(row[0]), name: String(row[1]), western: row[2], chinese: row[3] }));
  if (new Set(groups.map(group => group.id)).size !== groups.length) throw apiError_('CONFIG_ERROR', '喜餅共領ID重複');
  const records = cakeRecords_(readCakeRows_(getRequiredSheet_(ss, 'CakeLog'), CAKE_LOG_HEADERS));
  return groups.map(group => cakeView_(group, records));
}

function cakeView_(group, records) {
  const relevant = records.filter(record => record.groupId === group.id);
  const ids = new Set(), cancelled = new Set();
  relevant.forEach(record => {
    if (!record.id || ids.has(record.id) || !['發放', '撤銷'].includes(record.action)
      || !Number.isSafeInteger(record.western) || record.western < 0
      || !Number.isSafeInteger(record.chinese) || record.chinese < 0) {
      throw apiError_('CONFIG_ERROR', '喜餅紀錄異常，請管理者核對 CakeLog');
    }
    ids.add(record.id);
    if (record.action === '撤銷') {
      const original = relevant.find(item => item.id === record.originalId && item.action === '發放');
      if (!original || cancelled.has(original.id) || original.western !== record.western
        || original.chinese !== record.chinese) throw apiError_('CONFIG_ERROR', '喜餅撤銷紀錄異常');
      cancelled.add(original.id);
    }
  });
  const issues = relevant.filter(record => record.action === '發放')
    .map(record => Object.assign({}, record, { cancelled: cancelled.has(record.id) }));
  const issued = issues.filter(record => !record.cancelled).reduce((sum, record) => ({
    western: sum.western + record.western, chinese: sum.chinese + record.chinese
  }), { western: 0, chinese: 0 });
  return { id: group.id, name: group.name, western: cakeQuota_(group.western), chinese: cakeQuota_(group.chinese),
    issued, remaining: {
      western: group.western === '' || group.western == null ? null : group.western - issued.western,
      chinese: group.chinese === '' || group.chinese == null ? null : group.chinese - issued.chinese
    }, issues };
}

function createCakeModule_(deps) {
  return { execute(input) {
    const execute = () => {
      const guest = deps.guest(input.guestId);
      if (!guest || !guest.cakeGroupId) throw apiError_('NOT_FOUND', '賓客未設定喜餅共領單位');
      const groups = deps.groups().filter(group => group.id === guest.cakeGroupId);
      if (groups.length !== 1) throw apiError_('CONFIG_ERROR', '找不到唯一喜餅共領單位');
      const records = deps.records(), group = groups[0];
      const response = (status, record, currentRecords) => ({ ok: true, status, record,
        cake: cakeView_(group, currentRecords || deps.records()) });
      if (input.action === 'cakeStatus') return response('CAKE_STATUS', undefined, records);
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId || '') || !input.operator) {
        throw apiError_('BAD_REQUEST', '缺少有效請求編號或操作人員');
      }
      let data;
      try { data = typeof input.data === 'string' ? JSON.parse(input.data) : input.data; }
      catch (err) { throw apiError_('BAD_REQUEST', '喜餅操作格式錯誤'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw apiError_('BAD_REQUEST', '缺少喜餅操作');
      if (!['cakeIssue', 'cakeCancel'].includes(input.action)) throw apiError_('BAD_REQUEST', '不支援的喜餅操作');
      const action = input.action === 'cakeIssue' ? '發放' : '撤銷';
      let western = data.western, chinese = data.chinese;
      const originalId = String(data.originalId || ''), reason = String(data.reason || '').trim();
      if (reason.length > 500) throw apiError_('BAD_REQUEST', '原因限500字');
      if (action === '撤銷') {
        const original = records.find(item => item.id === originalId && item.groupId === group.id && item.action === '發放');
        if (!original || !reason) throw apiError_('BAD_REQUEST', '撤銷需選擇原發放紀錄並填原因');
        western = original.western; chinese = original.chinese;
      } else if (![western, chinese].every(value => Number.isSafeInteger(value) && value >= 0)
        || western + chinese < 1 || originalId) {
        throw apiError_('BAD_REQUEST', '請填非負整數盒數，至少發放一盒');
      }
      const replay = records.find(item => item.requestId === input.requestId);
      if (replay) {
        if (replay.groupId !== group.id || replay.guestId !== guest.guestId || replay.action !== action
          || replay.western !== western || replay.chinese !== chinese || replay.operator !== input.operator
          || replay.originalId !== originalId || replay.reason !== reason) {
          throw apiError_('REQUEST_REUSED', '同一請求不可更換內容或人員');
        }
        return response('CAKE_REPLAY', replay, records);
      }
      const view = cakeView_(group, records);
      if (action === '發放') {
        for (const kind of ['western', 'chinese']) {
          const quantity = kind === 'western' ? western : chinese;
          if (quantity && view.remaining[kind] == null) throw apiError_('UNKNOWN_QUOTA', '此品項配額尚未確認，不可發放');
          if (quantity > 0 && quantity > view.remaining[kind]) throw apiError_('ALREADY_ISSUED', '共領單位剩餘盒數不足，請核對是否已領');
        }
      } else if (view.issues.find(item => item.id === originalId).cancelled) {
        throw apiError_('ALREADY_CANCELLED', '此發放已撤銷，請重新查詢');
      }
      const record = { id: deps.uuid(), groupId: group.id, guestId: guest.guestId,
        action, western, chinese, operator: input.operator, at: deps.now(),
        requestId: input.requestId, originalId, reason };
      deps.append(record);
      return response('CAKE_SAVED', record);
    };
    return input.action === 'cakeStatus' ? execute() : deps.lock.runExclusive(execute);
  } };
}

function handleCakeApi_(payload, now) {
  const started = Date.now();
  const session = verifySessionToken_(payload.sessionToken, now), ss = getSpreadsheet_();
  const groups = getRequiredSheet_(ss, 'CakeGroups');
  const log = getRequiredSheet_(ss, 'CakeLog');
  const module = createCakeModule_({
    guest(id) {
      // Status display may use the trusted login index. Mutations always check
      // the current guest association, quotas and ledger under the write lock.
      if (payload.action === 'cakeStatus') {
        const cached = findCachedGiftGuest_(id);
        if (cached) return cached;
      }
      const matches = getRequiredSheet_(ss, 'Guests').getDataRange().getValues().slice(1)
        .filter(row => String(row[0]) === id);
      if (matches.length > 1) throw apiError_('CONFIG_ERROR', '賓客ID重複');
      return matches.length ? guestRecordFromRow_(matches[0]) : null;
    },
    groups: () => readCakeRows_(groups, CAKE_GROUP_HEADERS).filter(row => row[0])
      .map(row => ({ id: String(row[0]), name: String(row[1]), western: row[2], chinese: row[3] })),
    records: () => cakeRecords_(readCakeRows_(log, CAKE_LOG_HEADERS)),
    append(record) {
      log.appendRow([record.id, sheetText_(record.groupId), sheetText_(record.guestId), record.action,
        record.western, record.chinese, sheetText_(record.operator), now, record.requestId,
        record.originalId, sheetText_(record.reason)]);
      SpreadsheetApp.flush();
    },
    uuid: () => Utilities.getUuid(), now: () => now.toISOString(), lock: createScriptLock_(10000)
  });
  const result = module.execute(Object.assign({}, payload, { guestId: extractGuestId_(payload.guestId), operator: session.operator }));
  result.serverMs = Date.now() - started;
  return result;
}
