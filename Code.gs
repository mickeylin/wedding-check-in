const GUEST_HEADERS = [
  '賓客ID',
  '顯示姓名',
  '邀請單位',
  '新郎/新娘方',
  '分組',
  '桌號',
  '預計人數',
  '實到人數',
  '報到狀態',
  '操作人員',
  '報到時間',
  '報到站台',
  '備註'
];

const SCAN_LOG_HEADERS = [
  '掃描時間',
  '站台',
  '掃描內容',
  '處理結果',
  '賓客ID',
  '顯示姓名',
  '桌號',
  '訊息',
  '操作人員'
];

const API_STATION_NAME = 'GitHubPages';
const GUEST_COL = columnMap_(GUEST_HEADERS);

/**
 * 第一次使用時執行，建立 GitHub Pages 掃描 API 需要的工作表。
 */
function setupSheet() {
  const ss = getSpreadsheet_();
  const guestSheet = ensureSheet_(ss, 'Guests', GUEST_HEADERS);
  const scanLogSheet = ensureSheet_(ss, 'ScanLog', SCAN_LOG_HEADERS);

  guestSheet.setFrozenRows(1);
  guestSheet.getRange('G:H').setNumberFormat('0');
  guestSheet.getRange('K:K').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  guestSheet.autoResizeColumns(1, GUEST_HEADERS.length);

  scanLogSheet.setFrozenRows(1);
  scanLogSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  scanLogSheet.autoResizeColumns(1, SCAN_LOG_HEADERS.length);

  setupDashboard_(ss);

  return 'GitHub Pages 掃描報到工作表初始化完成';
}

function setupDashboard_(ss) {
  const sheet = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
  sheet.clear();
  sheet.getRange(1, 1, 8, 2).setValues([
    ['項目', '數值'],
    ['總組數', '=COUNTA(Guests!B2:B)'],
    ['已報到組數', '=COUNTIF(Guests!I2:I,"已報到")'],
    ['未報到組數', '=COUNTIFS(Guests!B2:B,"<>",Guests!I2:I,"<>已報到")'],
    ['總預計人數', '=SUM(Guests!G2:G)'],
    ['實到人數', '=SUM(Guests!H2:H)'],
    ['重複掃描次數', '=COUNTIF(ScanLog!D2:D,"ALREADY_CHECKED_IN")'],
    ['找不到 QR 次數', '=COUNTIF(ScanLog!D2:D,"NOT_FOUND")']
  ]);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 2);
}

/**
 * 對已有姓名的資料列補上賓客 ID。
 * QR Code 直接使用賓客 ID。
 */
function generateGuestIds() {
  const sheet = getGuestSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return '目前沒有賓客資料';

  const map = headerMap_(values[0], GUEST_HEADERS);
  let changed = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = String(row[map['顯示姓名']] || '').trim();
    if (!name) continue;

    if (!String(row[map['賓客ID']] || '').trim()) {
      row[map['賓客ID']] = 'G' + String(i).padStart(3, '0');
    }
    changed++;
  }

  sheet.getRange(2, 1, values.length - 1, GUEST_HEADERS.length)
    .setValues(values.slice(1).map(row => row.slice(0, GUEST_HEADERS.length)));

  return `已處理 ${changed} 筆資料`;
}

function doPost(e) {
  const now = new Date();
  try {
    const payload = parseApiPayload_(e);
    return jsonResponse_(handleApiCheckin_(payload, now));
  } catch (err) {
    return jsonResponse_({
      ok: false,
      status: 'ERROR',
      message: err && err.message ? err.message : String(err),
      processedAt: formatDate_(now)
    });
  }
}

function doGet(e) {
  const now = new Date();
  const params = e && e.parameter ? e.parameter : {};

  if (params.action === 'checkin') {
    const payload = {
      action: 'checkin',
      guestId: String(params.guestId || params.token || params.t || '').trim(),
      pin: String(params.pin || '').trim(),
      operator: String(params.operator || '').trim(),
      station: String(params.station || '').trim()
    };
    const body = safeApiCall_(payload, now);
    return params.callback
      ? jsonpResponse_(params.callback, body)
      : jsonResponse_(body);
  }

  return jsonResponse_({
    ok: true,
    service: 'wedding-check-in-api',
    message: 'API is running'
  });
}

function processScan_(ss, stationName, rawScan, now, operator) {
  const guestIdInput = extractGuestId_(rawScan);
  if (!guestIdInput) {
    return scanResult_('EMPTY_SCAN', '', '', '', '沒有掃描內容');
  }

  const result = findGuestById_(ss, guestIdInput);
  if (!result) {
    return scanResult_('NOT_FOUND', '', '', '', `找不到賓客 ID：${guestIdInput}`);
  }

  const { sheet, rowNumber, row } = result;
  const guestId = String(row[GUEST_COL['賓客ID']] || '');
  const displayName = String(row[GUEST_COL['顯示姓名']] || '');
  const tableNo = String(row[GUEST_COL['桌號']] || '');
  const wasCheckedIn = String(row[GUEST_COL['報到狀態']] || '').trim() === '已報到';

  if (wasCheckedIn) {
    const checkinTime = formatDate_(row[GUEST_COL['報到時間']]);
    const message = checkinTime ? `已報到，原報到時間：${checkinTime}` : '已報到';
    return scanResult_('ALREADY_CHECKED_IN', guestId, displayName, tableNo, message);
  }

  const existingActualCount = Number(row[GUEST_COL['實到人數']] || 0);
  const expectedCount = Number(row[GUEST_COL['預計人數']] || 0);
  const actualCount = existingActualCount || expectedCount || 1;

  sheet.getRange(rowNumber, GUEST_COL['實到人數'] + 1, 1, 5)
    .setValues([[
      actualCount,
      '已報到',
      operator,
      now,
      stationName
    ]]);

  return scanResult_('CHECKED_IN', guestId, displayName, tableNo, '報到成功');
}

function scanResult_(status, guestId, displayName, tableNo, message) {
  return { status, guestId, displayName, tableNo, message };
}

function appendScanLog_(ss, stationName, rawScan, result, operator, now) {
  const sheet = getRequiredSheet_(ss, 'ScanLog');
  sheet.appendRow([
    now,
    stationName,
    rawScan,
    result.status,
    result.guestId,
    result.displayName,
    result.tableNo,
    result.message,
    operator
  ]);
}

function findGuestById_(ss, guestId) {
  const sheet = getRequiredSheet_(ss, 'Guests');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const guestIdRange = sheet.getRange(2, GUEST_COL['賓客ID'] + 1, lastRow - 1, 1);
  const found = guestIdRange
    .createTextFinder(guestId)
    .matchEntireCell(true)
    .findNext();

  if (!found) return null;

  const rowNumber = found.getRow();
  return {
    sheet,
    rowNumber,
    row: sheet.getRange(rowNumber, 1, 1, GUEST_HEADERS.length).getValues()[0]
  };
}

function columnMap_(headers) {
  const map = {};
  headers.forEach((header, index) => {
    map[header] = index;
  });
  return map;
}

function getGuestSheet_() {
  return ensureSheet_(getSpreadsheet_(), 'Guests', GUEST_HEADERS);
}

function getSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) {
    throw new Error('找不到綁定的 Google Sheet，請設定 SPREADSHEET_ID');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = existing.every(value => !String(value).trim());

  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    headers.forEach((header, index) => {
      if (existing[index] !== header) {
        sheet.getRange(1, index + 1).setValue(header);
      }
    });
  }
  return sheet;
}

function getRequiredSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(`找不到工作表：${name}，請先執行 setupSheet`);
  }
  return sheet;
}

function headerMap_(headerRow, expectedHeaders) {
  const map = {};
  headerRow.forEach((value, index) => {
    map[String(value).trim()] = index;
  });

  expectedHeaders.forEach(header => {
    if (map[header] === undefined) {
      throw new Error(`缺少欄位：${header}`);
    }
  });
  return map;
}

function parseApiPayload_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  const payload = JSON.parse(raw);
  return {
    action: String(payload.action || 'checkin').trim(),
    guestId: String(payload.guestId || payload.token || payload.scan || '').trim(),
    pin: String(payload.pin || '').trim(),
    operator: String(payload.operator || '').trim(),
    station: String(payload.station || '').trim()
  };
}

function safeApiCall_(payload, now) {
  try {
    return handleApiCheckin_(payload, now);
  } catch (err) {
    return {
      ok: false,
      status: 'ERROR',
      message: err && err.message ? err.message : String(err),
      processedAt: formatDate_(now)
    };
  }
}

function handleApiCheckin_(payload, now) {
  verifyApiPin_(payload.pin);

  if (payload.action !== 'checkin') {
    throw new Error('不支援的 API action');
  }

  const ss = getSpreadsheet_();
  const stationName = payload.station || API_STATION_NAME;
  const operator = payload.operator || getScanOperator_();
  const result = processScan_(ss, stationName, payload.guestId, now, operator);
  appendScanLog_(ss, stationName, payload.guestId, result, operator, now);

  return {
    ok: result.status === 'CHECKED_IN' || result.status === 'ALREADY_CHECKED_IN',
    status: result.status,
    guestId: result.guestId,
    displayName: result.displayName,
    tableNo: result.tableNo,
    message: result.message,
    processedAt: formatDate_(now)
  };
}

function verifyApiPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_PIN');
  if (!expected) {
    throw new Error('尚未設定 API_PIN');
  }
  if (String(pin || '') !== String(expected)) {
    throw new Error('PIN 不正確');
  }
}

function extractGuestId_(rawScan) {
  const value = String(rawScan || '').trim();
  if (!value) return '';

  const queryMatch = value.match(/[?&]t=([^&#]+)/);
  if (queryMatch) {
    return decodeURIComponent(queryMatch[1]).trim();
  }

  const hashMatch = value.match(/[#&]t=([^&#]+)/);
  if (hashMatch) {
    return decodeURIComponent(hashMatch[1]).trim();
  }

  return value;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpResponse_(callbackName, payload) {
  const safeCallback = String(callbackName || '').replace(/[^\w.$]/g, '');
  if (!safeCallback) {
    return jsonResponse_({
      ok: false,
      status: 'ERROR',
      message: 'callback 不正確'
    });
  }

  return ContentService
    .createTextOutput(`${safeCallback}(${JSON.stringify(payload)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function getScanOperator_() {
  try {
    const email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    return String(email || '').trim().toLowerCase() || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function formatDate_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
}
