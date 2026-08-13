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
  const isManual = options.source === 'manual';

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

function renderApiResult(data, guestId) {
  const result = data || {};

  if (result.status === 'UNAUTHORIZED') {
    clearSessionToken();
    showResult('工作階段已過期', '請重新輸入 PIN 後再試。', 'warn');
    addRecent(result.status, guestId, result.message || '請重新建立工作階段');
    return;
  }

  const title = (result.status || 'UNKNOWN') + ' ' + (result.displayName || '');
  const detail = [
    result.tableNo ? '桌號 ' + result.tableNo : '',
    result.guestId ? '賓客 ' + result.guestId : '',
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
