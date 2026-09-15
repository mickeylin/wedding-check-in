const GUEST_HEADERS = ['賓客ID', '顯示姓名', '新郎/新娘方', '桌號', '備註'];
const LEGACY_GUEST_HEADERS = ['預計人數', '實到人數', '報到狀態', '操作人員', '報到時間'];

const API_STATION_NAME = 'GitHubPages';
const SESSION_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_PROPERTY_PREFIX = 'CHECKIN_SESSION_';
const SCRIPT_CACHE_MAX_TTL_SECONDS = 6 * 60 * 60;
const LOOKUP_MAX_RESULTS = 100;
const GUEST_COL = columnMap_(GUEST_HEADERS);

/**
 * 第一次使用時執行，建立 GitHub Pages 掃描 API 需要的工作表。
 */
function setupSheet() {
  const ss = getSpreadsheet_();
  const guestSheet = ensureGuestSheet_(ss);
  guestSheet.setFrozenRows(1);
  guestSheet.autoResizeColumns(1, GUEST_HEADERS.length);
  ['ScanLog', 'Dashboard'].forEach(name => {
    const legacy = ss.getSheetByName(name);
    if (legacy) {
      legacy.setName(uniqueArchiveName_(ss, name));
      legacy.hideSheet();
    }
  });
  setupGiftRegister_(ss);

  return '數位禮金簿初始化完成；請另執行 installGiftEditTrigger';
}

function uniqueArchiveName_(ss, name) {
  const base = name + '_Archive_' + Date.now();
  let candidate = base;
  let suffix = 1;
  while (ss.getSheetByName(candidate)) candidate = base + '_' + suffix++;
  return candidate;
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
  const usedIds = new Set(values.slice(1).map(row => String(row[map['賓客ID']] || '').trim()).filter(Boolean));
  let nextId = 1;
  let changed = 0;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const name = String(row[map['顯示姓名']] || '').trim();
    if (!name) continue;

    if (!String(row[map['賓客ID']] || '').trim()) {
      while (usedIds.has('G' + String(nextId).padStart(3, '0'))) nextId++;
      row[map['賓客ID']] = 'G' + String(nextId++).padStart(3, '0');
      usedIds.add(row[map['賓客ID']]);
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
    return jsonResponse_(safeApiCall_(payload, now));
  } catch (err) {
    return jsonResponse_(errorResponse_(err, now));
  }
}

function doGet(e) {
  const now = new Date();
  const params = e && e.parameter ? e.parameter : {};
  let payload = null;

  if (params.action === 'session') {
    payload = {
      action: 'session',
      pin: String(params.pin || '').trim(),
      operator: String(params.operator || '').trim(),
      station: String(params.station || '').trim(),
      includeGuestSnapshot: String(params.includeGuestSnapshot || '').trim() === '1'
    };
  } else if (['guest', 'receive', 'cancel', 'checkin'].indexOf(params.action) !== -1) {
    payload = {
      action: params.action,
      guestId: String(params.guestId || params.t || params.token || '').trim(),
      sessionToken: String(params.sessionToken || '').trim(),
      requestId: String(params.requestId || '').trim(),
      receiptId: String(params.receiptId || '').trim()
    };
  } else if (params.action === 'lookup') {
    payload = {
      action: 'lookup',
      query: String(params.query || '').trim(),
      category: String(params.category || params.side || '').trim(),
      sessionToken: String(params.sessionToken || '').trim(),
      requestId: String(params.requestId || '').trim()
    };
  } else {
    return jsonResponse_({
      ok: true,
      service: 'wedding-check-in-api',
      message: 'API is running'
    });
  }

  const body = safeApiCall_(payload, now);
  return params.callback
    ? jsonpResponse_(params.callback, body)
    : jsonResponse_(body);
}

function columnMap_(headers) {
  const map = {};
  headers.forEach((header, index) => {
    map[header] = index;
  });
  return map;
}

function ensureGuestSheet_(ss) {
  let sheet = ss.getSheetByName('Guests');
  if (!sheet) sheet = ss.insertSheet('Guests');

  const lastRow = Math.max(sheet.getLastRow(), 1);
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const existingHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(value => String(value || '').trim());
  const hasHeader = existingHeaders.some(Boolean);

  if (!hasHeader) {
    if (lastRow > 1) {
      throw new Error('Guests 第一列缺少標題，請先整理或備份資料');
    }
    sheet.getRange(1, 1, 1, GUEST_HEADERS.length).setValues([GUEST_HEADERS]);
    return sheet;
  }

  const existingMap = columnMap_(existingHeaders);
  const namedHeaders = existingHeaders.filter(Boolean);
  if (new Set(namedHeaders).size !== namedHeaders.length) {
    throw new Error('Guests 欄位名稱重複，請先整理標題再升級');
  }
  const missingHeaders = ['賓客ID', '顯示姓名'].filter(header => existingMap[header] === undefined);
  if (missingHeaders.length) {
    throw new Error('Guests 缺少必要欄位：' + missingHeaders.join('、'));
  }

  const isCanonical = GUEST_HEADERS.every((header, index) => existingHeaders[index] === header);
  const hasLegacy = existingHeaders.some(header => LEGACY_GUEST_HEADERS.includes(header));
  if (isCanonical && !hasLegacy) return sheet;

  const rows = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues()
    : [];
  // Preserve custom columns and their contents during canonical schema migration.
  const extras = existingHeaders.map((header, index) => ({ header, index }))
    .filter(item => GUEST_HEADERS.indexOf(item.header) === -1 && !LEGACY_GUEST_HEADERS.includes(item.header));
  const migratedHeaders = GUEST_HEADERS.concat(extras.map(item => item.header));
  const migratedRows = rows.map(row => GUEST_HEADERS.map(header => existingMap[header] === undefined ? '' : row[existingMap[header]])
    .concat(extras.map(item => row[item.index])));

  // Preserve a full recoverable copy before moving or removing any existing columns.
  sheet.copyTo(ss).setName(uniqueArchiveName_(ss, 'Guests')).hideSheet();
  sheet.getRange(1, 1, lastRow, lastColumn).clearContent();
  sheet.getRange(1, 1, lastRow, lastColumn).clearFormat();
  sheet.getRange(1, 1, 1, migratedHeaders.length).setValues([migratedHeaders]);
  if (migratedRows.length) {
    sheet.getRange(2, 1, migratedRows.length, migratedHeaders.length).setValues(migratedRows);
  }
  return sheet;
}
function getGuestSheet_() {
  return ensureGuestSheet_(getSpreadsheet_());
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

function createGoogleSheetsGuestStore_(ss) {
  return {
    search(query, category) {
      const sheet = getRequiredSheet_(ss, 'Guests');
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];
      const normalizedQuery = normalizeLookupText_(query);
      const filterCategories = lookupCategoriesForFilter_(category);
      const rows = sheet
        .getRange(2, 1, lastRow - 1, GUEST_HEADERS.length)
        .getValues();
      return rows
        .map(guestRecordFromRow_)
        .filter(guest => {
          if (!guest.displayName) return false;
          if (filterCategories.length
            && filterCategories.indexOf(normalizeLookupText_(guest.category)) === -1) {
            return false;
          }
          const name = normalizeLookupText_(guest.displayName);
          const guestId = normalizeLookupText_(guest.guestId);
          return !normalizedQuery
            || name.includes(normalizedQuery)
            || guestId.includes(normalizedQuery);
        })
        .sort((left, right) => {
          const rankDifference = lookupMatchRank_(left, normalizedQuery)
            - lookupMatchRank_(right, normalizedQuery);
          return rankDifference || left.displayName.localeCompare(right.displayName);
        });
    }
  };
}

function guestRecordFromRow_(row) {
  return {
    guestId: String(row[GUEST_COL['賓客ID']] || '').trim(),
    displayName: String(row[GUEST_COL['顯示姓名']] || '').trim(),
    category: String(row[GUEST_COL['新郎/新娘方']] || '').trim(),
    tableNo: String(row[GUEST_COL['桌號']] || '').trim(),
    notes: String(row[GUEST_COL['備註']] || '').trim()
  };
}

function lookupMatchRank_(guest, query) {
  if (!query) return 2;
  const name = normalizeLookupText_(guest.displayName);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (normalizeLookupText_(guest.guestId) === query) return 1;
  return 2;
}

function createScriptLock_(timeoutMs) {
  const waitMs = Number(timeoutMs) || 5000;

  return {
    runExclusive(callback) {
      const scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(waitMs)) {
        throw apiError_('BUSY', '系統忙碌，請稍後再試');
      }

      try {
        return callback();
      } finally {
        scriptLock.releaseLock();
      }
    }
  };
}

function parseApiPayload_(e) {
  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw apiError_('BAD_REQUEST', '請提供有效的 JSON payload');
  }

  return {
    action: String(payload.action || 'guest').trim(),
    receiptId: String(payload.receiptId || '').trim(),
    guestId: String(payload.guestId || payload.token || payload.scan || '').trim(),
    pin: String(payload.pin || '').trim(),
    operator: String(payload.operator || '').trim(),
    station: String(payload.station || '').trim(),
    query: String(payload.query || '').trim(),
    category: String(payload.category || payload.side || '').trim(),
    sessionToken: String(payload.sessionToken || '').trim(),
    requestId: String(payload.requestId || '').trim(),
    includeGuestSnapshot: payload.includeGuestSnapshot === true || String(payload.includeGuestSnapshot || '') === '1'
  };
}

function safeApiCall_(payload, now) {
  try {
    if (payload.action === 'session') {
      const started = Date.now();
      const result = handleApiSession_(payload, now);
      if (payload.includeGuestSnapshot) {
        Object.assign(result, createGiftSnapshot_(getSpreadsheet_()), {
          serverMs: Date.now() - started
        });
      }
      return Object.assign({}, result, {
        processedAt: formatDate_(now)
      });
    }

    if (payload.action === 'checkin') {
      throw apiError_('UPGRADE_REQUIRED', '請重新整理新版頁面；掃描已改為查詢，不再自動報到');
    }

    if (['guest', 'receive', 'cancel'].indexOf(payload.action) !== -1) {
      return handleGiftApi_(payload, now);
    }

    if (payload.action === 'lookup') {
      return handleApiLookup_(payload, now);
    }

    throw apiError_('BAD_REQUEST', '不支援的 API action');
  } catch (err) {
    return errorResponse_(err, now);
  }
}

function errorResponse_(err, now) {
  const status = err && err.code ? err.code : 'ERROR';
  return {
    ok: false,
    status,
    message: err && err.message ? err.message : String(err),
    processedAt: formatDate_(now),
    retryable: status === 'BUSY'
  };
}

function handleApiLookup_(payload, now) {
  if (payload.action !== 'lookup') {
    throw apiError_('BAD_REQUEST', '不支援的 API action');
  }
  verifySessionToken_(payload.sessionToken, now);
  const ss = getSpreadsheet_();
  const module = createGuestLookupModule_({
    guestStore: createGoogleSheetsGuestStore_(ss),
    maxResults: LOOKUP_MAX_RESULTS
  });
  const result = module.search({
    query: payload.query,
    category: payload.category
  });
  return Object.assign({}, result, {
    processedAt: formatDate_(now),
    requestId: payload.requestId || ''
  });
}

function apiError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeApiTime_(value) {
  return value instanceof Date ? value : new Date(value || new Date());
}

function getScriptCache_() {
  try {
    return typeof CacheService !== 'undefined' && CacheService
      ? CacheService.getScriptCache()
      : null;
  } catch (err) {
    return null;
  }
}

function safeCacheGet_(key) {
  const cache = getScriptCache_();
  if (!cache) return null;
  try { return cache.get(key); } catch (err) { return null; }
}

function safeCachePut_(key, value, ttlSeconds) {
  const cache = getScriptCache_();
  if (!cache) return;
  try { cache.put(key, value, Math.max(1, Math.min(SCRIPT_CACHE_MAX_TTL_SECONDS, ttlSeconds))); } catch (err) {}
}

function safeCacheRemove_(key) {
  const cache = getScriptCache_();
  if (!cache) return;
  try { cache.remove(key); } catch (err) {}
}

function handleApiSession_(payload, now) {
  const input = payload || {};
  const currentTime = normalizeApiTime_(now);
  verifyApiPin_(input.pin);

  const operator = String(input.operator || '').trim();
  if (!operator) {
    throw apiError_('INVALID_SESSION', '請輸入操作人員');
  }
  const station = String(input.station || API_STATION_NAME).trim() || API_STATION_NAME;
  const sessionToken = Utilities.getUuid();
  const expiresAt = currentTime.getTime() + SESSION_TOKEN_TTL_MS;
  const session = { operator, station, expiresAt };

  const propertyKey = SESSION_PROPERTY_PREFIX + sessionToken;
  const serialized = JSON.stringify(session);
  PropertiesService.getScriptProperties().setProperty(propertyKey, serialized);
  safeCachePut_(propertyKey, serialized, Math.ceil(SESSION_TOKEN_TTL_MS / 1000));

  return {
    ok: true,
    status: 'SESSION_CREATED',
    sessionToken,
    operator,
    station,
    expiresAt
  };
}

function verifySessionToken_(sessionToken, now) {
  const token = String(sessionToken || '').trim();
  if (!token) {
    throw apiError_('UNAUTHORIZED', '需要 session token');
  }

  const propertyKey = SESSION_PROPERTY_PREFIX + token;
  let raw = safeCacheGet_(propertyKey);
  const cacheHit = !!raw;
  if (!raw) raw = PropertiesService.getScriptProperties().getProperty(propertyKey);
  if (!raw) {
    throw apiError_('UNAUTHORIZED', 'session token 無效或已過期');
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch (err) {
    safeCacheRemove_(propertyKey);
    PropertiesService.getScriptProperties().deleteProperty(propertyKey);
    throw apiError_('UNAUTHORIZED', 'session token 無效或已過期');
  }

  const currentTime = normalizeApiTime_(now);
  if (!session.expiresAt || currentTime.getTime() >= Number(session.expiresAt)) {
    safeCacheRemove_(propertyKey);
    PropertiesService.getScriptProperties().deleteProperty(propertyKey);
    throw apiError_('UNAUTHORIZED', 'session token 已過期');
  }

  if (!cacheHit) {
    safeCachePut_(propertyKey, raw,
      Math.ceil((Number(session.expiresAt) - currentTime.getTime()) / 1000));
  }

  return session;
}

function verifyApiPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_PIN');
  if (!expected) {
    throw apiError_('CONFIG_ERROR', '尚未設定 API_PIN');
  }
  if (String(pin || '') !== String(expected)) {
    throw apiError_('UNAUTHORIZED', 'PIN 不正確');
  }
}

function normalizeLookupText_(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}
function lookupCategoriesForFilter_(category) {
  const normalizedCategory = normalizeLookupText_(category);
  if (!normalizedCategory) return [];

  if (normalizedCategory === normalizeLookupText_('男方朋友')
    || normalizedCategory === normalizeLookupText_('女方朋友')) {
    return [normalizedCategory, normalizeLookupText_('共同朋友')];
  }

  // 保留舊版頁面送出的三種概略值，讓前後端分開部署時不會暫時失效。
  const legacyCategoryMap = {
    [normalizeLookupText_('男方')]: ['男方家人', '男方朋友', '男方同事'],
    [normalizeLookupText_('女方')]: ['女方家人', '女方媽媽同事', '女方朋友', '女方同事'],
    [normalizeLookupText_('共同')]: ['共同朋友']
  };
  if (legacyCategoryMap[normalizedCategory]) {
    return legacyCategoryMap[normalizedCategory].map(value => normalizeLookupText_(value));
  }

  return [normalizedCategory];
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

function formatDate_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss');
}

function createGuestLookupModule_(dependencies) {
  const guestStore = dependencies.guestStore;
  const maxResults = Math.max(1, Number(dependencies.maxResults) || LOOKUP_MAX_RESULTS);
  return {
    search(request) {
      const input = request || {};
      const query = String(input.query || '').trim();
      const category = String(input.category || input.side || '').trim();
      if (!query && !category) {
        return {
          ok: false,
          status: 'EMPTY_LOOKUP',
          query,
          category,
          results: [],
          hasMore: false,
          message: '請輸入姓名或選擇關係分類'
        };
      }
      const matches = guestStore.search(query, category);
      const hasMore = matches.length > maxResults;
      const results = matches.slice(0, maxResults).map(guest => ({
        guestId: guest.guestId,
        displayName: guest.displayName,
        category: guest.category,
        tableNo: guest.tableNo,
        notes: guest.notes || ''
      }));
      return {
        ok: true,
        status: results.length ? 'LOOKUP_RESULTS' : 'NO_MATCHES',
        query,
        category,
        results,
        hasMore,
        message: results.length ? '' : '找不到符合的賓客'
      };
    }
  };
}
