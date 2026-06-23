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
  '收禮狀態',
  '禮金金額',
  '紅包編號',
  '操作人員',
  '報到時間',
  '備註',
  'QR連結',
  '報到站台'
];

const STAFF_HEADERS = [
  'Email',
  '顯示名稱',
  '角色',
  '啟用狀態',
  '備註'
];

const GIFT_LOG_HEADERS = [
  '紀錄時間',
  '動作',
  '賓客ID',
  'QR_TOKEN',
  '顯示姓名',
  '桌號',
  '實到人數',
  '收禮狀態',
  '禮金金額',
  '紅包編號',
  '操作人員Email',
  '操作人員名稱',
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

const ALLOWED_GIFT_STATUS = ['未收禮', '已收禮', '代包', '免禮'];
const GIFT_STATUS_REQUIRES_ENVELOPE = ['已收禮', '代包'];
const ENABLED_STAFF_VALUES = ['啟用', '是', 'yes', 'y', 'true', '1', 'active'];

function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');
  const initialToken = String((e && e.parameter && e.parameter.t) || '').trim();
  template.initialToken = initialToken;
  template.initialGuest = null;
  template.initialError = '';

  if (initialToken) {
    try {
      const result = findGuestByToken_(initialToken);
      if (result) {
        template.initialGuest = guestObject_(result.row, result.map);
      } else {
        template.initialError = '找不到此賓客，請改用姓名搜尋';
      }
    } catch (err) {
      template.initialError = err && err.message ? err.message : String(err);
    }
  }

  return template
    .evaluate()
    .setTitle('婚禮報到系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 第一次使用時執行。
 * 需要先在「專案設定 → 指令碼屬性」新增：
 * SPREADSHEET_ID：Google Sheet 網址中的試算表 ID
 * WEB_APP_URL：部署後的 Web App URL（第一次可先不填）
 */
function setupSheet() {
  const ss = getSpreadsheet_();
  const guestSheet = ensureSheet_(ss, 'Guests', GUEST_HEADERS);
  const staffSheet = ensureSheet_(ss, 'Staff', STAFF_HEADERS);
  const giftLogSheet = ensureSheet_(ss, 'GiftLog', GIFT_LOG_HEADERS);
  const scanLogSheet = ensureSheet_(ss, 'ScanLog', SCAN_LOG_HEADERS);

  guestSheet.setFrozenRows(1);
  guestSheet.getRange('H:I').setNumberFormat('0');
  guestSheet.getRange('L:L').setNumberFormat('#,##0');
  guestSheet.getRange('O:O').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  guestSheet.autoResizeColumns(1, GUEST_HEADERS.length);

  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ALLOWED_GIFT_STATUS, true)
    .setAllowInvalid(false)
    .build();
  guestSheet.getRange(2, 11, Math.max(guestSheet.getMaxRows() - 1, 1), 1)
    .setDataValidation(statusRule);

  staffSheet.setFrozenRows(1);
  staffSheet.autoResizeColumns(1, STAFF_HEADERS.length);
  seedCurrentUserAsStaff_(staffSheet);

  giftLogSheet.setFrozenRows(1);
  giftLogSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  giftLogSheet.getRange('I:I').setNumberFormat('#,##0');
  giftLogSheet.autoResizeColumns(1, GIFT_LOG_HEADERS.length);

  scanLogSheet.setFrozenRows(1);
  scanLogSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  scanLogSheet.autoResizeColumns(1, SCAN_LOG_HEADERS.length);

  setupScanStationSheets_(ss);
  setupDashboard_(ss);

  return '工作表初始化完成';
}

/**
 * 可單獨執行，用來補建無前端條碼機掃描版所需工作表。
 */
function setupScannerSheets() {
  const ss = getSpreadsheet_();
  ensureSheet_(ss, 'Guests', GUEST_HEADERS);
  const scanLogSheet = ensureSheet_(ss, 'ScanLog', SCAN_LOG_HEADERS);
  scanLogSheet.setFrozenRows(1);
  scanLogSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  scanLogSheet.autoResizeColumns(1, SCAN_LOG_HEADERS.length);
  setupScanStationSheets_(ss);
  setupDashboard_(ss);
  return '掃描版工作表初始化完成';
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
 * 對已有姓名的資料列補上賓客 ID、隨機 Token 與 QR 連結。
 * 部署 Web App 並填入 WEB_APP_URL 後再執行一次。
 */
function generateIdsAndLinks() {
  const props = getProperties_();
  const webAppUrl = props.WEB_APP_URL || '';
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

    const token = String(row[map['QR_TOKEN']]);
    row[map['QR連結']] = webAppUrl ? webAppUrl + '?t=' + encodeURIComponent(token) : '';
    changed++;
  }

  sheet.getRange(2, 1, values.length - 1, GUEST_HEADERS.length)
    .setValues(values.slice(1).map(r => r.slice(0, GUEST_HEADERS.length)));

  return `已處理 ${changed} 筆資料`;
}

function getCurrentStaff() {
  return requireStaff_();
}

function getGuestByToken(token) {
  requireStaff_();
  token = String(token || '').trim();
  if (!token) throw new Error('缺少 QR Token');

  const result = findGuestByToken_(token);
  if (!result) throw new Error('找不到此賓客，請改用姓名搜尋');
  return guestObject_(result.row, result.map);
}

function autoCheckinByToken(token) {
  const staff = requireStaff_();
  token = String(token || '').trim();
  if (!token) throw new Error('缺少 QR Token');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const result = findGuestByToken_(token);
    if (!result) throw new Error('找不到此賓客，請改用姓名搜尋');

    const { sheet, rowNumber, row, map } = result;
    const wasCheckedIn = String(row[map['報到狀態']] || '').trim() === '已報到';

    if (!wasCheckedIn) {
      const existingActualCount = Number(row[map['實到人數']] || 0);
      const expectedCount = Number(row[map['預計人數']] || 0);
      row[map['實到人數']] = existingActualCount || expectedCount || 1;
      row[map['報到狀態']] = '已報到';
      row[map['收禮狀態']] = String(row[map['收禮狀態']] || '未收禮') || '未收禮';
      row[map['操作人員']] = staff.name;
      row[map['報到時間']] = new Date();

      sheet.getRange(rowNumber, 1, 1, GUEST_HEADERS.length)
        .setValues([row.slice(0, GUEST_HEADERS.length)]);
      appendGiftLog_('AUTO_CHECKIN', row, map, staff);
    }

    const guest = guestObject_(row, map);
    guest.autoCheckinStatus = wasCheckedIn ? 'already_checked_in' : 'checked_in';
    return guest;
  } finally {
    lock.releaseLock();
  }
}

function searchGuests(keyword) {
  requireStaff_();
  keyword = String(keyword || '').trim().toLowerCase();
  if (!keyword) return [];

  const sheet = getGuestSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const map = headerMap_(values[0], GUEST_HEADERS);
  const fields = ['賓客ID', '顯示姓名', '邀請單位', '桌號', '分組'];
  const results = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const haystack = fields
      .map(h => String(row[map[h]] || '').toLowerCase())
      .join(' | ');

    if (haystack.includes(keyword)) {
      results.push(guestObject_(row, map));
      if (results.length >= 20) break;
    }
  }
  return results;
}

function saveCheckin(payload) {
  const staff = requireStaff_();
  if (!payload || !payload.token) throw new Error('缺少賓客資料');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const result = findGuestByToken_(String(payload.token).trim());
    if (!result) throw new Error('找不到此賓客');

    const { sheet, rowNumber, row, map } = result;
    const wasCheckedIn = String(row[map['報到狀態']] || '').trim() === '已報到';
    const actualCount = parseInteger_(payload.actualCount, '實到人數', 0, 30);
    const giftStatus = String(payload.giftStatus || '未收禮').trim();
    const needsGiftFields = GIFT_STATUS_REQUIRES_ENVELOPE.includes(giftStatus);
    const giftAmount = needsGiftFields
      ? parseInteger_(payload.giftAmount || 0, '禮金金額', 0, 10000000)
      : 0;
    const envelopeNo = needsGiftFields ? String(payload.envelopeNo || '').trim() : '';
    const notes = String(payload.notes || '').trim();

    if (!ALLOWED_GIFT_STATUS.includes(giftStatus)) {
      throw new Error('收禮狀態不正確');
    }
    if (needsGiftFields && !envelopeNo) {
      throw new Error('已收禮或代包時，請輸入紅包編號');
    }

    row[map['實到人數']] = actualCount;
    row[map['報到狀態']] = '已報到';
    row[map['收禮狀態']] = giftStatus;
    row[map['禮金金額']] = giftAmount;
    row[map['紅包編號']] = envelopeNo;
    row[map['操作人員']] = staff.name;
    row[map['報到時間']] = new Date();
    row[map['備註']] = notes;

    sheet.getRange(rowNumber, 1, 1, GUEST_HEADERS.length)
      .setValues([row.slice(0, GUEST_HEADERS.length)]);
    appendGiftLog_(wasCheckedIn ? 'UPDATE' : 'CREATE', row, map, staff);

    return guestObject_(row, map);
  } finally {
    lock.releaseLock();
  }
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
  const token = extractTokenFromScan_(rawScan);
  if (!token) {
    return {
      status: 'EMPTY_SCAN',
      guestId: '',
      displayName: '',
      tableNo: '',
      message: '沒有掃描內容'
    };
  }

  const result = findGuestByTokenInSpreadsheet_(ss, token);
  if (!result) {
    return {
      status: 'NOT_FOUND',
      guestId: '',
      displayName: '',
      tableNo: '',
      message: `找不到 QR Token：${token}`
    };
  }

  const { sheet, rowNumber, row, map } = result;
  const wasCheckedIn = String(row[map['報到狀態']] || '').trim() === '已報到';
  const guestId = String(row[map['賓客ID']] || '');
  const displayName = String(row[map['顯示姓名']] || '');
  const tableNo = String(row[map['桌號']] || '');

  if (wasCheckedIn) {
    const checkinTime = formatDate_(row[map['報到時間']]);
    return {
      status: 'ALREADY_CHECKED_IN',
      guestId,
      displayName,
      tableNo,
      message: checkinTime ? `已報到，原報到時間：${checkinTime}` : '已報到'
    };
  }

  const existingActualCount = Number(row[map['實到人數']] || 0);
  const expectedCount = Number(row[map['預計人數']] || 0);
  row[map['實到人數']] = existingActualCount || expectedCount || 1;
  row[map['報到狀態']] = '已報到';
  row[map['收禮狀態']] = String(row[map['收禮狀態']] || '未收禮') || '未收禮';
  row[map['操作人員']] = operator;
  row[map['報到時間']] = now;
  row[map['報到站台']] = stationName;

  sheet.getRange(rowNumber, 1, 1, GUEST_HEADERS.length)
    .setValues([row.slice(0, GUEST_HEADERS.length)]);

  return {
    status: 'CHECKED_IN',
    guestId,
    displayName,
    tableNo,
    message: '報到成功'
  };
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

function findGuestByTokenInSpreadsheet_(ss, token) {
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

function extractTokenFromScan_(rawScan) {
  const value = String(rawScan || '').trim();
  if (!value) return '';

  const tokenMatch = value.match(/[?&]t=([^&#]+)/);
  if (tokenMatch) {
    return decodeURIComponent(tokenMatch[1]).trim();
  }

  return value;
}

function getScanOperator_() {
  try {
    const email = getEffectiveEmail_();
    return email || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function getGuestSheet_() {
  return ensureSheet_(getSpreadsheet_(), 'Guests', GUEST_HEADERS);
}

function getStaffSheet_() {
  return getSpreadsheet_().getSheetByName('Staff');
}

function getGiftLogSheet_() {
  return ensureSheet_(getSpreadsheet_(), 'GiftLog', GIFT_LOG_HEADERS);
}

function getSpreadsheet_() {
  const props = getProperties_();
  if (!props.SPREADSHEET_ID) {
    throw new Error('尚未設定 SPREADSHEET_ID');
  }
  return SpreadsheetApp.openById(props.SPREADSHEET_ID);
}

function getProperties_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);

  const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = existing.every(v => !String(v).trim());

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

function seedCurrentUserAsStaff_(staffSheet) {
  const email = getEffectiveEmail_();
  if (!email || staffSheet.getLastRow() > 1) return;

  const name = email.split('@')[0];
  staffSheet.getRange(2, 1, 1, STAFF_HEADERS.length)
    .setValues([[email, name, '管理員', '啟用', 'setupSheet 自動加入']]);
}

function getEffectiveEmail_() {
  const activeEmail = Session.getActiveUser().getEmail();
  if (activeEmail) return String(activeEmail).trim().toLowerCase();

  const effectiveEmail = Session.getEffectiveUser().getEmail();
  return String(effectiveEmail || '').trim().toLowerCase();
}

function requireStaff_() {
  // Speed-test mode: skip Google account allow-list checks temporarily.
  return {
    email: 'speed-test',
    name: '測試模式',
    role: '測試'
  };
}

function findGuestByToken_(token) {
  const sheet = getGuestSheet_();
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

function appendGiftLog_(action, row, map, staff) {
  const sheet = getGiftLogSheet_();
  if (!sheet) throw new Error('尚未建立 GiftLog 工作表，請先執行 setupSheet');

  sheet.appendRow([
    new Date(),
    action,
    String(row[map['賓客ID']] || ''),
    String(row[map['QR_TOKEN']] || ''),
    String(row[map['顯示姓名']] || ''),
    String(row[map['桌號']] || ''),
    Number(row[map['實到人數']] || 0),
    String(row[map['收禮狀態']] || ''),
    Number(row[map['禮金金額']] || 0),
    String(row[map['紅包編號']] || ''),
    staff.email,
    staff.name,
    String(row[map['備註']] || '')
  ]);
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

function guestObject_(row, map) {
  return {
    guestId: String(row[map['賓客ID']] || ''),
    token: String(row[map['QR_TOKEN']] || ''),
    displayName: String(row[map['顯示姓名']] || ''),
    partyName: String(row[map['邀請單位']] || ''),
    side: String(row[map['新郎/新娘方']] || ''),
    group: String(row[map['分組']] || ''),
    tableNo: String(row[map['桌號']] || ''),
    expectedCount: Number(row[map['預計人數']] || 0),
    actualCount: Number(row[map['實到人數']] || 0),
    checkinStatus: String(row[map['報到狀態']] || '未報到'),
    giftStatus: String(row[map['收禮狀態']] || '未收禮'),
    giftAmount: Number(row[map['禮金金額']] || 0),
    envelopeNo: String(row[map['紅包編號']] || ''),
    operator: String(row[map['操作人員']] || ''),
    checkinTime: formatDate_(row[map['報到時間']]),
    checkinStation: map['報到站台'] === undefined ? '' : String(row[map['報到站台']] || ''),
    notes: String(row[map['備註']] || '')
  };
}

function parseInteger_(value, fieldName, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${fieldName} 必須是 ${min}～${max} 的整數`);
  }
  return number;
}

function formatDate_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
}
