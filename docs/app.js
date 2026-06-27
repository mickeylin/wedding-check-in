const STORAGE_KEY = 'wedding-check-in-settings';
const SCAN_COOLDOWN_MS = 1800;

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
let isSubmitting = false;
let lastGuestId = '';
let lastScanAt = 0;

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
  submitCheckin(guestId);
  elements.manualGuestId.value = '';
});

async function startScanner() {
  if (isScanning) return;
  if (!validateSettings()) return;

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
  const now = Date.now();

  if (!guestId || isSubmitting) return;
  if (guestId === lastGuestId && now - lastScanAt < SCAN_COOLDOWN_MS) return;

  lastGuestId = guestId;
  lastScanAt = now;
  submitCheckin(guestId);
}

async function submitCheckin(guestId) {
  if (!validateSettings()) return;

  const settings = getSettings();
  isSubmitting = true;
  pauseScanner();
  showResult('處理中', guestId, 'neutral');

  try {
    const data = await jsonpCheckin(settings, guestId);
    renderApiResult(data, guestId);
  } catch (err) {
    showResult('API 呼叫失敗', `${messageOf(err)}。請確認 Apps Script Web App URL、PIN 與部署權限。`, 'error');
    addRecent('ERROR', guestId, messageOf(err));
  } finally {
    window.setTimeout(() => {
      isSubmitting = false;
      resumeScanner();
    }, SCAN_COOLDOWN_MS);
  }
}

function jsonpCheckin(settings, guestId) {
  return new Promise((resolve, reject) => {
    const callbackName = `weddingCheckin_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
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
    url.searchParams.set('action', 'checkin');
    url.searchParams.set('guestId', guestId);
    url.searchParams.set('pin', settings.pin);
    url.searchParams.set('station', settings.station);
    url.searchParams.set('operator', settings.operator);
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
  const title = `${data.status || 'UNKNOWN'} ${data.displayName || ''}`.trim();
  const detail = [
    data.tableNo ? `桌號 ${data.tableNo}` : '',
    data.guestId ? `賓客 ${data.guestId}` : '',
    data.message || ''
  ].filter(Boolean).join(' / ');

  const tone = data.status === 'CHECKED_IN'
    ? 'success'
    : data.status === 'ALREADY_CHECKED_IN'
      ? 'warn'
      : 'error';

  showResult(title, detail || guestId, tone);
  addRecent(data.status || 'UNKNOWN', guestId, detail || data.message || '');
}

function pauseScanner() {
  try {
    if (scanner && isScanning) scanner.pause(true);
  } catch (err) {
    // Some browser/library combinations do not support pause during decode.
  }
}

function resumeScanner() {
  try {
    if (scanner && isScanning) scanner.resume();
  } catch (err) {
    // Scanner is still usable through the next decode callback.
  }
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
  if (!settings.pin) {
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
    operator: elements.operator.value.trim() || 'unknown'
  };
}

function saveSettings() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(getSettings()));
  updateConnectionStatus();
}

function loadSettings() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const settings = JSON.parse(raw);
    elements.apiUrl.value = settings.apiUrl || '';
    elements.pin.value = settings.pin || '';
    elements.station.value = settings.station || 'GitHubPages';
    elements.operator.value = settings.operator || '';
  } catch (err) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
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
