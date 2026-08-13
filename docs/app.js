const STORAGE_KEY = 'wedding-check-in-settings';
const SESSION_STORAGE_KEY = 'wedding-check-in-session-token';
const DUPLICATE_SCAN_COOLDOWN_MS = 2500;
const MAX_IN_FLIGHT_CHECKINS = 3;

const elements = {
  apiUrl: document.querySelector('#apiUrl'),
  pin: document.querySelector('#pin'),
  station: document.querySelector('#station'),
  operator: document.querySelector('#operator'),
  saveSettingsButton: document.querySelector('#saveSettingsButton'),
  startButton: document.querySelector('#startButton'),
  stopButton: document.querySelector('#stopButton'),
  manualForm: document.querySelector('#manualForm'),
  manualGuestId: document.querySelector('#manualGuestId'),
  lookupForm: document.querySelector('#lookupForm'),
  lookupQuery: document.querySelector('#lookupQuery'),
  lookupCategory: document.querySelector('#lookupCategory'),
  lookupStatus: document.querySelector('#lookupStatus'),
  lookupResults: document.querySelector('#lookupResults'),
  resultBox: document.querySelector('#resultBox'),
  recentList: document.querySelector('#recentList'),
  connectionStatus: document.querySelector('#connectionStatus')
};

let scanner = null;
let isScanning = false;
let sessionPromise = null;
let inFlightCheckins = 0;
const pendingGuestIds = new Set();
const recentGuestIdScanAt = new Map();

loadSettings();
updateConnectionStatus();

elements.saveSettingsButton.addEventListener('click', () => {
  saveSettings();
  showResult('設定已儲存', '可以開始掃描。', 'success');
});

elements.startButton.addEventListener('click', startScanner);
elements.stopButton.addEventListener('click', stopScanner);

elements.manualForm.addEventListener('submit', event => {
  event.preventDefault();
  const guestId = extractGuestId(elements.manualGuestId.value);
  if (!guestId) {
    showResult('沒有輸入賓客 ID', '請輸入賓客 ID。', 'warn');
    return;
  }
  enqueueCheckin(guestId, { source: 'manual' });
  elements.manualGuestId.value = '';
});

elements.lookupForm.addEventListener('submit', event => {
  event.preventDefault();
  searchGuests();
});

async function startScanner() {
  if (isScanning) return;
  if (!validateSettings()) return;
  if (!(await ensureSession())) return;

  scanner = scanner || new Html5Qrcode('reader');

  try {
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      onQrDecoded
    );
    isScanning = true;
    elements.startButton.disabled = true;
    elements.stopButton.disabled = false;
    showResult('掃描中', '請將 QR Code 對準鏡頭。', 'neutral');
  } catch (err) {
    showResult('無法啟動相機', messageOf(err), 'error');
  }
}

async function stopScanner() {
  if (!scanner || !isScanning) return;
  try {
    await scanner.stop();
  } finally {
    isScanning = false;
    elements.startButton.disabled = false;
    elements.stopButton.disabled = true;
  }
}

function onQrDecoded(decodedText) {
  const guestId = extractGuestId(decodedText);

  if (!guestId) return;
  enqueueCheckin(guestId, { source: 'scanner' });
}

async function enqueueCheckin(guestId, options = {}) {
  if (!validateSettings()) return;
  if (!(await ensureSession())) return;

  const now = Date.now();
  const lastScanAt = recentGuestIdScanAt.get(guestId) || 0;
  const isManual = options.source !== 'scanner';

  if (pendingGuestIds.has(guestId)) {
    if (isManual) showResult('報到處理中', guestId + ' 已送出，請等待回應。', 'warn');
    return;
  }

  if (!isManual && now - lastScanAt < DUPLICATE_SCAN_COOLDOWN_MS) return;

  if (inFlightCheckins >= MAX_IN_FLIGHT_CHECKINS) {
    showResult('處理佇列忙碌', '請稍等前一批報到完成。', 'warn');
    return;
  }

  recentGuestIdScanAt.set(guestId, now);
  pruneRecentGuestIds(now);
  submitCheckin(guestId);
}
async function submitCheckin(guestId) {
  const settings = getSettings();
  const requestId = createRequestId();
  pendingGuestIds.add(guestId);
  inFlightCheckins += 1;
  showResult('已送出報到', guestId + ' 已送出，鏡頭可繼續掃描。', 'neutral');

  try {
    const data = await jsonpCheckin(settings, guestId, requestId);
    renderApiResult(data, guestId);
  } catch (err) {
    showResult(
      'API 呼叫失敗',
      messageOf(err) + '。請確認 Apps Script Web App URL 與工作階段設定。',
      'error'
    );
    addRecent('ERROR', guestId, messageOf(err));
  } finally {
    pendingGuestIds.delete(guestId);
    recentGuestIdScanAt.set(guestId, Date.now());
    inFlightCheckins = Math.max(0, inFlightCheckins - 1);
    pruneRecentGuestIds(Date.now());
  }
}

function pruneRecentGuestIds(now) {
  const maxAgeMs = DUPLICATE_SCAN_COOLDOWN_MS * 4;
  recentGuestIdScanAt.forEach((lastScanAt, guestId) => {
    if (now - lastScanAt > maxAgeMs) {
      recentGuestIdScanAt.delete(guestId);
    }
  });
}

async function searchGuests() {
  if (!validateSettings()) return;
  const query = elements.lookupQuery.value.trim();
  const category = elements.lookupCategory.value.trim();
  if (!query) {
    elements.lookupStatus.textContent = '請輸入姓名或稱呼。';
    elements.lookupResults.replaceChildren();
    return;
  }
  if (!(await ensureSession())) return;
  elements.lookupStatus.textContent = '查找中⋯';
  elements.lookupResults.replaceChildren();
  try {
    const data = await jsonpLookup(getSettings(), query, category);
    renderLookupResults(data);
  } catch (err) {
    elements.lookupStatus.textContent = '查找失敗：' + messageOf(err);
  }
}

function jsonpLookup(settings, query, category) {
  return jsonpRequest(settings, {
    action: 'lookup',
    query,
    category,
    sessionToken: settings.sessionToken || readSessionToken(),
    requestId: createRequestId()
  });
}

function ensureSession() {
  const settings = getSettings();
  if (settings.sessionToken) return Promise.resolve(true);

  if (!settings.pin) {
    showResult('缺少 PIN', '請輸入工作人員 PIN。', 'warn');
    return Promise.resolve(false);
  }

  if (sessionPromise) return sessionPromise;

  sessionPromise = jsonpSession(settings)
    .then(data => {
      if (!data || data.status !== 'SESSION_CREATED' || !data.sessionToken) {
        showResult(
          '無法建立工作階段',
          data && data.message ? data.message : 'API 未建立工作階段。',
          'error'
        );
        return false;
      }

      window.sessionStorage.setItem(SESSION_STORAGE_KEY, data.sessionToken);
      return true;
    })
    .catch(err => {
      showResult(
        '無法建立工作階段',
        messageOf(err) + '。請確認 Apps Script Web App URL、PIN 與部署權限。',
        'error'
      );
      return false;
    })
    .finally(() => {
      sessionPromise = null;
    });

  return sessionPromise;
}

function jsonpSession(settings) {
  return jsonpRequest(settings, {
    action: 'session',
    pin: settings.pin,
    station: settings.station,
    operator: settings.operator
  });
}

function jsonpCheckin(settings, guestId, requestId) {
  return jsonpRequest(settings, {
    action: 'checkin',
    guestId,
    sessionToken: settings.sessionToken || readSessionToken(),
    requestId
  });
}

function jsonpRequest(settings, params) {
  return new Promise((resolve, reject) => {
    const callbackName = 'weddingCheckin_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('API 回應逾時'));
    }, 12000);

    window[callbackName] = data => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('API 載入失敗'));
    };

    const url = new URL(settings.apiUrl);
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== '') {
        url.searchParams.set(key, params[key]);
      }
    });
    url.searchParams.set('callback', callbackName);

    script.src = url.toString();
    document.body.appendChild(script);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }
  });
}

function handleUnauthorized(message) {
  clearSessionToken();
  updateConnectionStatus();
  showResult('工作階段已過期', message || '請重新輸入 PIN 後再試。', 'warn');
}

function renderApiResult(data, guestId) {
  const result = data || {};
  if (result.status === 'UNAUTHORIZED') {
    handleUnauthorized('請重新輸入 PIN 後再試。');
    addRecent(result.status, guestId, result.message || '請重新建立工作階段');
    return;
  }
  const title = result.status === 'CHECKED_IN'
    ? '報到成功'
    : result.status === 'ALREADY_CHECKED_IN'
      ? '已完成報到'
      : (result.status || 'UNKNOWN') + ' ' + (result.displayName || '');
  const detail = [
    result.displayName ? '姓名 ' + result.displayName : '',
    result.tableNo ? '桌號 ' + result.tableNo : '',
    result.message || ''
  ].filter(Boolean).join(' / ');
  const tone = result.status === 'CHECKED_IN'
    ? 'success'
    : result.status === 'ALREADY_CHECKED_IN'
      ? 'warn'
      : 'error';
  showResult(title.trim(), detail || guestId, tone);
  addRecent(result.status || 'UNKNOWN', guestId, detail || result.message || '');
}

function renderLookupResults(data) {
  const result = data || {};
  elements.lookupResults.replaceChildren();
  if (result.status === 'UNAUTHORIZED') {
    handleUnauthorized('請重新輸入 PIN 後再查找。');
    elements.lookupStatus.textContent = '';
    return;
  }
  if (result.status === 'EMPTY_LOOKUP') {
    elements.lookupStatus.textContent = result.message || '請輸入姓名或稱呼。';
    return;
  }
  const results = Array.isArray(result.results) ? result.results : [];
  if (!results.length) {
    elements.lookupStatus.textContent = result.message || '找不到符合的賓客。';
    return;
  }
  elements.lookupStatus.textContent = result.hasMore
    ? '找到前 ' + results.length + ' 筆，請輸入更完整的姓名。'
    : '找到 ' + results.length + ' 筆，請確認姓名與關係分類。';
  results.forEach(guest => {
    const isCheckedIn = guest.checkInStatus === '已報到';
    const card = document.createElement('article');
    card.className = 'lookup-card' + (isCheckedIn ? ' is-checked-in' : '');
    const categoryText = guest.category ? '關係分類 ' + guest.category : '關係分類未填寫';
    const tableText = guest.tableNo ? '桌號 ' + guest.tableNo : '桌號尚未分配';
    const checkInText = isCheckedIn ? '已報到' : '尚未報到';
    card.innerHTML = [
      '<div class="lookup-card-title">' + escapeHtml(guest.displayName || '未命名賓客') + '</div>',
      '<div class="lookup-card-meta">',
      '<span>' + escapeHtml(categoryText) + '</span>',
      '<span>' + escapeHtml(tableText) + ' / 預計 ' + escapeHtml(guest.expectedCount || 0) + ' 人</span>',
      '<span>' + escapeHtml(checkInText) + '</span>',
      '</div>'
    ].join('');
    const actions = document.createElement('div');
    actions.className = 'lookup-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = isCheckedIn || !guest.guestId;
    button.textContent = isCheckedIn
      ? '已報到'
      : guest.guestId
        ? '報到'
        : '缺少賓客 ID';
    button.addEventListener('click', () => {
      const confirmation = [
        '確認是這位賓客嗎？',
        '姓名：' + (guest.displayName || '未命名賓客'),
        '關係分類：' + (guest.category || '未填寫'),
        tableText
      ].join('\\n');
      if (window.confirm(confirmation)) {
        enqueueCheckin(guest.guestId, { source: 'lookup' });
      }
    });
    actions.append(button);
    card.append(actions);
    elements.lookupResults.append(card);
  });
}

function extractGuestId(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    const guestId = url.searchParams.get('t') || url.hash.match(/[?#&]t=([^&#]+)/)?.[1] || value;
    return decodeURIComponent(guestId).trim();
  } catch (err) {
    const guestId = value.match(/[?&]t=([^&#]+)/)?.[1] || value.match(/[#&]t=([^&#]+)/)?.[1] || value;
    return decodeURIComponent(guestId).trim();
  }
}

function validateSettings() {
  const settings = getSettings();
  if (!settings.apiUrl) {
    showResult('缺少 API URL', '請先貼上 Apps Script Web App URL。', 'warn');
    return false;
  }
  if (!settings.sessionToken && !settings.pin) {
    showResult('缺少 PIN', '請輸入工作人員 PIN。', 'warn');
    return false;
  }
  return true;
}

function getSettings() {
  return {
    apiUrl: elements.apiUrl.value.trim(),
    pin: elements.pin.value.trim(),
    station: elements.station.value.trim() || 'GitHubPages',
    operator: elements.operator.value.trim() || 'unknown',
    sessionToken: readSessionToken()
  };
}

function saveSettings() {
  const settings = getSettings();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    apiUrl: settings.apiUrl,
    station: settings.station,
    operator: settings.operator
  }));
  clearSessionToken();
  sessionPromise = null;
  updateConnectionStatus();
}

function loadSettings() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const settings = JSON.parse(raw);
    elements.apiUrl.value = settings.apiUrl || '';
    elements.pin.value = '';
    elements.station.value = settings.station || 'GitHubPages';
    elements.operator.value = settings.operator || '';

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiUrl: elements.apiUrl.value,
      station: elements.station.value,
      operator: elements.operator.value
    }));
  } catch (err) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function readSessionToken() {
  return window.sessionStorage.getItem(SESSION_STORAGE_KEY) || '';
}

function clearSessionToken() {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

function createRequestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'req-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
}

function updateConnectionStatus() {
  elements.connectionStatus.textContent = elements.apiUrl.value.trim() ? 'API 已設定' : '未設定';
}

function showResult(title, message, tone) {
  elements.resultBox.className = `result-box ${tone || 'neutral'}`;
  elements.resultBox.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(message || '')}</span>`;
}

function addRecent(status, guestId, message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} ${status} ${message || guestId}`;
  elements.recentList.prepend(item);

  while (elements.recentList.children.length > 8) {
    elements.recentList.lastElementChild.remove();
  }
}

function messageOf(err) {
  return err && err.message ? err.message : String(err);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}
