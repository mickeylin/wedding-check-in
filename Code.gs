const GUEST_HEADERS = [
  '賓客ID',
  'QR_TOKEN',
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

const SCAN_STATION_HEADERS = [
  '掃描內容',
  '處理結果',
  '顯示姓名',
  '桌號',
  '訊息',
  '處理時間'
];

const SCAN_STATION_SHEETS = ['Scan_入口A', 'Scan_入口B', 'Scan_備用'];
const API_STATION_NAME = 'GitHubPages';

/**
 * 第一次使用時執行，建立手機掃描與條碼機備援共用的工作表。
 */
function setupSheet() {
  const ss = getSpreadsheet_();
  const guestSheet = ensureSheet_(ss, 'Guests', GUEST_HEADERS);
  const scanLogSheet = ensureSheet_(ss, 'ScanLog', SCAN_LOG_HEADERS);

  guestSheet.setFrozenRows(1);
  guestSheet.getRange('H:I').setNumberFormat('0');
  guestSheet.getRange('L:L').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  guestSheet.autoResizeColumns(1, GUEST_HEADERS.length);

  scanLogSheet.setFrozenRows(1);
  scanLogSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  scanLogSheet.autoResizeColumns(1, SCAN_LOG_HEADERS.length);

  setupScanStationSheets_(ss);
  setupDashboard_(ss);

  return '條碼機報到工作表初始化完成';
}

function setupScanStationSheets_(ss) {
  SCAN_STATION_SHEETS.forEach(name => {
    const sheet = ensureSheet_(ss, name, SCAN_STATION_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange('F:F').setNumberFormat('yyyy/mm/dd hh:mm:ss');
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(3, 180);
    sheet.setColumnWidth(4, 80);
    sheet.setColumnWidth(5, 260);
    sheet.setColumnWidth(6, 160);
  });
}

function setupDashboard_(ss) {
  const sheet = ss.getSheetByName('Dashboard') || ss.insertSheet('Dashboard');
  sheet.clear();
  sheet.getRange(1, 1, 8, 2).setValues([
    ['項目', '數值'],
    ['總組數', '=COUNTA(Guests!C2:C)'],
    ['已報到組數', '=COUNTIF(Guests!J2:J,"已報到")'],
    ['未報到組數', '=COUNTIFS(Guests!C2:C,"<>",Guests!J2:J,"<>已報到")'],
    ['總預計人數', '=SUM(Guests!H2:H)'],
    ['實到人數', '=SUM(Guests!I2:I)'],
    ['重複掃描次數', '=COUNTIF(ScanLog!D2:D,"ALREADY_CHECKED_IN")'],
    ['找不到 QR 次數', '=COUNTIF(ScanLog!D2:D,"NOT_FOUND")']
  ]);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 2);
}

/**
 * 對已有姓名的資料列補上賓客 ID 與隨機 QR_TOKEN。
 * QR Code 可使用 GitHub Pages 穩定網址並以 t 參數帶入 QR_TOKEN。
 */
function generateGuestTokens() {
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
    if (!String(row[map['QR_TOKEN']] || '').trim()) {
      row[map['QR_TOKEN']] = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
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
      token: String(params.token || params.t || '').trim(),
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

function onEdit(e) {
  handleScanEdit_(e);
}

function handleScanEdit_(e) {
  if (!e || !e.range) return;

  const range = e.range;
  const sheet = range.getSheet();
  const stationName = sheet.getName();

  if (!SCAN_STATION_SHEETS.includes(stationName)) return;
  if (range.getRow() < 2 || range.getColumn() !== 1) return;
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;

  const rawScan = String(range.getValue() || '').trim();
  const now = new Date();
  const operator = getScanOperator_();
  const ss = e.source || getSpreadsheet_();

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const result = processScan_(ss, stationName, rawScan, now, operator);
    writeScanStationResult_(sheet, range.getRow(), result, now);
    appendScanLog_(ss, stationName, rawScan, result, operator, now);
  } catch (err) {
    const result = {
      status: 'ERROR',
      guestId: '',
      displayName: '',
      tableNo: '',
      message: err && err.message ? err.message : String(err)
    };
    writeScanStationResult_(sheet, range.getRow(), result, now);
    appendScanLog_(ss, stationName, rawScan, result, operator, now);
  } finally {
    lock.releaseLock();
  }
}

function processScan_(ss, stationName, rawScan, now, operator) {
  const token = extractToken_(rawScan);
  if (!token) {
    return scanResult_('EMPTY_SCAN', '', '', '', '沒有掃描內容');
  }

  const result = findGuestByToken_(ss, token);
  if (!result) {
    return scanResult_('NOT_FOUND', '', '', '', `找不到 QR Token：${token}`);
  }

  const { sheet, rowNumber, row, map } = result;
  const guestId = String(row[map['賓客ID']] || '');
  const displayName = String(row[map['顯示姓名']] || '');
  const tableNo = String(row[map['桌號']] || '');
  const wasCheckedIn = String(row[map['報到狀態']] || '').trim() === '已報到';

  if (wasCheckedIn) {
    const checkinTime = formatDate_(row[map['報到時間']]);
    const message = checkinTime ? `已報到，原報到時間：${checkinTime}` : '已報到';
    return scanResult_('ALREADY_CHECKED_IN', guestId, displayName, tableNo, message);
  }

  const existingActualCount = Number(row[map['實到人數']] || 0);
  const expectedCount = Number(row[map['預計人數']] || 0);
  row[map['實到人數']] = existingActualCount || expectedCount || 1;
  row[map['報到狀態']] = '已報到';
  row[map['操作人員']] = operator;
  row[map['報到時間']] = now;
  row[map['報到站台']] = stationName;

  sheet.getRange(rowNumber, 1, 1, GUEST_HEADERS.length)
    .setValues([row.slice(0, GUEST_HEADERS.length)]);

  return scanResult_('CHECKED_IN', guestId, displayName, tableNo, '報到成功');
}

function scanResult_(status, guestId, displayName, tableNo, message) {
  return { status, guestId, displayName, tableNo, message };
}

function writeScanStationResult_(sheet, rowNumber, result, now) {
  sheet.getRange(rowNumber, 2, 1, 5).setValues([[
    result.status,
    result.displayName,
    result.tableNo,
    result.message,
    now
  ]]);

  const colorMap = {
    CHECKED_IN: '#dff3e4',
    ALREADY_CHECKED_IN: '#fff6d9',
    NOT_FOUND: '#f8d7da',
    EMPTY_SCAN: '#eeeeee',
    ERROR: '#f8d7da'
  };
  sheet.getRange(rowNumber, 1, 1, SCAN_STATION_HEADERS.length)
    .setBackground(colorMap[result.status] || '#ffffff');
}

function appendScanLog_(ss, stationName, rawScan, result, operator, now) {
  const sheet = ensureSheet_(ss, 'ScanLog', SCAN_LOG_HEADERS);
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

function findGuestByToken_(ss, token) {
  const sheet = ensureSheet_(ss, 'Guests', GUEST_HEADERS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  const map = headerMap_(values[0], GUEST_HEADERS);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][map['QR_TOKEN']] || '').trim() === token) {
      return {
        sheet,
        rowNumber: i + 1,
        row: values[i],
        map
      };
    }
  }
  return null;
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
    token: String(payload.token || payload.scan || '').trim(),
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
  const result = processScan_(ss, stationName, payload.token, now, operator);
  appendScanLog_(ss, stationName, payload.token, result, operator, now);

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

function extractToken_(rawScan) {
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
