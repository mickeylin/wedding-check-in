const STORAGE_KEY = 'wedding-check-in-settings';
const SESSION_STORAGE_KEY = 'wedding-check-in-session-token';
const SESSION_EXPIRES_STORAGE_KEY = 'wedding-check-in-session-expires-at';
const GUEST_SNAPSHOT_STORAGE_KEY = 'wedding-check-in-guest-snapshot';
const DUPLICATE_SCAN_COOLDOWN_MS = 2500;

const elements = {
  apiUrl: document.querySelector('#apiUrl'),
  pin: document.querySelector('#pin'),

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
  connectionStatus: document.querySelector('#connectionStatus'),
  checkinModal: document.querySelector('#checkinModal'),
  checkinModalCard: document.querySelector('#checkinModalCard'),
  checkinModalTitle: document.querySelector('#checkinModalTitle'),
  checkinModalMessage: document.querySelector('#checkinModalMessage'),
  nextGuestButton: document.querySelector('#nextGuestButton')
};
elements.receiveButton = document.querySelector('#receiveButton');
elements.cancelReceiptButton = document.querySelector('#cancelReceiptButton');
elements.timingStatus = document.querySelector('#timingStatus');
let selectedGuest = null;
let giftBusy = false;
const guestSnapshot = new Map();

elements.receiveButton.addEventListener('click', () => mutateGift('receive'));
elements.cancelReceiptButton.addEventListener('click', () => {
  if (selectedGuest && window.confirm('撤銷 ' + selectedGuest.displayName + ' 的待清點收件？')) mutateGift('cancel');
});

let scanner = null;
let isScanning = false;
let sessionPromise = null;

const recentGuestIdScanAt = new Map();
const checkinGate = window.CheckinGate.create();
let shouldResumeScannerAfterGate = false;

loadSettings();
loadGuestSnapshot();
updateConnectionStatus();

elements.saveSettingsButton.addEventListener('click', async () => {
  elements.saveSettingsButton.disabled = true;
  showResult('正在登入', '正在建立工作階段，完成後即可開始掃描。', 'neutral');
  try {
    if (await saveSettings()) {
      showResult('設定已儲存', '登入完成，可以開始掃描。', 'success');
    }
  } finally {
    elements.saveSettingsButton.disabled = false;
  }
});

elements.startButton.addEventListener('click', startScanner);
elements.stopButton.addEventListener('click', stopScanner);
elements.nextGuestButton.addEventListener('click', continueToNextGuest);

elements.manualForm.addEventListener('submit', event => {
  event.preventDefault();
  const guestId = extractGuestId(elements.manualGuestId.value);
  if (!guestId) {
    showResult('沒有輸入賓客 ID', '請輸入賓客 ID。', 'warn');
    return;
  }
  queryGuest(guestId, { source: 'manual' });
  elements.manualGuestId.value = '';
});

elements.lookupForm.addEventListener('submit', event => {
  event.preventDefault();
  searchGuests();
});

async function startScanner() {
  if (checkinGate.state() !== 'READY' || isScanning) return;
  if (!validateSettings()) return;
  if (!(await ensureSession())) return;

  try {
    scanner = scanner || new Html5Qrcode('reader');
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
  queryGuest(guestId, { source: 'scanner' });
}

async function queryGuest(guestId, options = {}) {
  const operationStarted = Date.now();
  const isManual = options.source !== 'scanner';
  if (!checkinGate.begin()) {
    if (isManual) {
      showResult('請先完成目前查詢', '按「下一位」後再操作。', 'warn');
    }
    return;
  }

  if (!validateSettings()) {
    checkinGate.reset();
    return;
  }
  const needsSession = !readSessionToken();
  const sessionStarted = Date.now();
  if (!(await ensureSession())) {
    checkinGate.reset();
    return;
  }
  const sessionMs = needsSession ? Date.now() - sessionStarted : 0;

  const now = Date.now();
  const lastScanAt = recentGuestIdScanAt.get(guestId) || 0;

  if (!isManual && now - lastScanAt < DUPLICATE_SCAN_COOLDOWN_MS) {
    checkinGate.reset();
    return;
  }

  recentGuestIdScanAt.set(guestId, now);
  pruneRecentGuestIds(now);
  await loadGuest(guestId, operationStarted, sessionMs);
}
async function loadGuest(guestId, operationStarted = Date.now(), sessionMs = 0) {
  const settings = getSettings();
  const requestId = createRequestId();
  shouldResumeScannerAfterGate = isScanning;

  try {
    // The gate suppresses additional decodes while this guest is open.
    // Keep the camera stream alive instead of waiting for stop/start per guest.
    selectedGuest = null;
    updateGiftButtons();
    const cached = guestSnapshot.get(guestId);
    if (cached) {
      const data = { ...cached, ok: true, localSnapshot: true };
      recordGiftTiming('查詢', operationStarted, data, sessionMs);
      renderGiftResult(data);
      return;
    }
    showResult('查詢中', guestId + '：正在查詢桌號與紅包狀態。', 'neutral');

    const data = await jsonpGuest(settings, guestId, requestId);
    rememberGuest(data);
    recordGiftTiming('查詢', operationStarted, data, sessionMs);
    renderGiftResult(data);
  } catch (err) {
    recordGiftTiming('查詢失敗', operationStarted, null, sessionMs);
    const message = messageOf(err) + '。請確認 Apps Script Web App URL 與工作階段設定。';
    showResult('API 呼叫失敗', message, 'error');
    addRecent('ERROR', guestId, messageOf(err));
    openCheckinGate('API 呼叫失敗', message, 'error');
  } finally {
    recentGuestIdScanAt.set(guestId, Date.now());
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
  if (!query && !category) {
    elements.lookupStatus.textContent = '請輸入姓名或選擇關係分類。';
    elements.lookupResults.replaceChildren();
    return;
  }
  if (!(await ensureSession())) return;
  if (guestSnapshot.size) {
    renderLookupResults(searchGuestSnapshot(query, category));
    return;
  }
  elements.lookupStatus.textContent = '查找中⋯';
  elements.lookupResults.replaceChildren();
  try {
    const data = await jsonpLookup(getSettings(), query, category);
    renderLookupResults(data);
  } catch (err) {
    elements.lookupStatus.textContent = '查找失敗：' + messageOf(err);
  }
}

function searchGuestSnapshot(query, category) {
  const normalizedQuery = normalizeLookupText(query);
  const categories = lookupCategoriesForFilter(category);
  const matches = Array.from(guestSnapshot.values()).filter(guest => {
    if (categories.length && !categories.includes(normalizeLookupText(guest.category))) return false;
    return !normalizedQuery
      || normalizeLookupText(guest.displayName).includes(normalizedQuery)
      || normalizeLookupText(guest.guestId).includes(normalizedQuery);
  }).sort((left, right) => String(left.displayName).localeCompare(String(right.displayName)));
  return {
    ok: true,
    status: matches.length ? 'LOOKUP_RESULTS' : 'NO_MATCHES',
    results: matches.slice(0, 100),
    hasMore: matches.length > 100,
    message: matches.length ? '' : '找不到符合的賓客'
  };
}

function normalizeLookupText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function lookupCategoriesForFilter(category) {
  const normalized = normalizeLookupText(category);
  if (!normalized) return [];
  if (normalized === normalizeLookupText('男方朋友')
    || normalized === normalizeLookupText('女方朋友')) {
    return [normalized, normalizeLookupText('共同朋友')];
  }
  return [normalized];
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
      if (data.expiresAt) {
        window.sessionStorage.setItem(SESSION_EXPIRES_STORAGE_KEY, String(data.expiresAt));
      }
      if (Array.isArray(data.guests)) applyGuestSnapshot(data.guests);
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
    operator: settings.operator,
    includeGuestSnapshot: '1'
  });
}

function jsonpGuest(settings, guestId, requestId) {
  return jsonpRequest(settings, {
    action: 'guest',
    guestId,
    sessionToken: settings.sessionToken || readSessionToken(),
    requestId
  });
}

function jsonpRequest(settings, params) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const callbackName = 'weddingCheckin_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
    const script = document.createElement('script');
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('API 回應逾時'));
    }, 12000);

    window[callbackName] = data => {
      // Timing only: no PIN, token, guest identity or amounts in diagnostics.
      window.lastGiftTiming = { action: params.action, totalMs: Date.now() - started,
        serverMs: data && data.serverMs, lockWaitMs: data && data.lockWaitMs,
        authMs: data && data.authMs, guestLookupMs: data && data.guestLookupMs,
        giftReadMs: data && data.giftReadMs, giftWriteMs: data && data.giftWriteMs,
        flushMs: data && data.flushMs };
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

function openCheckinGate(title, message, tone) {
  checkinGate.complete();
  elements.checkinModalCard.className = 'checkin-modal-card ' + (tone || 'neutral');
  elements.checkinModalTitle.textContent = title;
  elements.checkinModalMessage.textContent = message || '';
  elements.checkinModal.hidden = false;
  elements.nextGuestButton.focus();
}

function updateGiftButtons() {
  elements.receiveButton.hidden = !selectedGuest || selectedGuest.giftState !== '未收件';
  elements.cancelReceiptButton.hidden = !selectedGuest || !selectedGuest.canCancel;
  elements.receiveButton.disabled = giftBusy;
  elements.cancelReceiptButton.disabled = giftBusy;
  elements.nextGuestButton.disabled = giftBusy;
}

function renderGiftResult(data) {
  if (!data || !data.ok) {
    selectedGuest = null;
    if (data && data.status === 'UNAUTHORIZED') handleUnauthorized(data.message);
    updateGiftButtons();
    openCheckinGate('請重新查詢', data && data.message || '無法取得資料', 'error');
    return;
  }
  selectedGuest = data;
  const detail = ['賓客編號：' + data.guestId, '桌號：' + (data.tableNo || '尚未分配'),
    '紅包：' + data.giftState, data.message || ''].join('\n');
  openCheckinGate(data.displayName, detail, data.giftState === '未收件' ? 'neutral' : 'success');
  showResult(data.displayName, detail, 'neutral');
  updateGiftButtons();
}

async function mutateGift(action) {
  if (giftBusy || !selectedGuest) return;
  const guest = selectedGuest;
  const operationStarted = Date.now();
  giftBusy = true;
  updateGiftButtons();
  elements.checkinModalMessage.textContent = action === 'receive'
    ? '正在登記收到紅包；請先在紅包寫上賓客編號 ' + guest.guestId + '，並等候成功確認…'
    : '正在撤銷收件，請稍候確認結果…';
  try {
    const data = await jsonpRequest(getSettings(), { action, guestId: guest.guestId,
      receiptId: guest.receiptId, sessionToken: readSessionToken(), requestId: createRequestId() });
    rememberGuest(data);
    recordGiftTiming(action === 'receive' ? '收件' : '撤銷', operationStarted, data);
    renderGiftResult(data);
    if (data && data.ok) addRecent(data.status, guest.guestId, guest.displayName + '：' + data.message);
  } catch (err) {
    recordGiftTiming('操作失敗', operationStarted, null);
    selectedGuest = null;
    openCheckinGate('收件狀態待確認', messageOf(err) + '。可能已寫入；請按下一位後重新查詢，核對狀態再操作。斷網時使用紙本備援。', 'error');
  } finally {
    giftBusy = false;
    updateGiftButtons();
  }
}

function recordGiftTiming(label, started, data, sessionMs = 0) {
  if (!elements.timingStatus) return;
  const totalMs = Date.now() - started;
  const seconds = ms => (ms / 1000).toFixed(2) + ' 秒';
  const lines = [label + '總等待：' + seconds(totalMs)];
  if (sessionMs > 0) lines.push('其中登入：' + seconds(sessionMs));
  if (data && data.localSnapshot) {
    lines.push('資料來源：本機快照（收件仍由後端確認）');
  } else if (data && typeof data.serverMs === 'number') {
    lines.push('後端處理：' + seconds(data.serverMs));
    lines.push('其中等鎖：' + seconds(data.lockWaitMs || 0));
    if (typeof data.authMs === 'number') lines.push('其中驗證工作階段：' + seconds(data.authMs));
    if (typeof data.guestLookupMs === 'number') lines.push('其中取得賓客：' + seconds(data.guestLookupMs));
    if (typeof data.giftReadMs === 'number') lines.push('其中讀取禮金：' + seconds(data.giftReadMs));
    if (typeof data.giftWriteMs === 'number') lines.push('其中寫入禮金：' + seconds(data.giftWriteMs));
    if (typeof data.flushMs === 'number') lines.push('其中確認寫入：' + seconds(data.flushMs));
    lines.push('其餘往返／平台／頁面：' + seconds(Math.max(0, totalMs - sessionMs - data.serverMs)));
  } else {
    lines.push('後端耗時未提供（舊部署或請求失敗）');
  }
  elements.timingStatus.textContent = lines.join('\n');
}

async function continueToNextGuest() {
  if (giftBusy) return;
  selectedGuest = null;
  updateGiftButtons();
  const resumeScanner = shouldResumeScannerAfterGate;
  shouldResumeScannerAfterGate = false;
  elements.nextGuestButton.disabled = true;
  elements.checkinModal.hidden = true;
  checkinGate.reset();

  try {
    if (resumeScanner) {
      await startScanner();
    } else {
      elements.manualGuestId.focus();
    }
  } finally {
    elements.nextGuestButton.disabled = false;
  }
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
    elements.lookupStatus.textContent = result.message || '請輸入姓名或選擇關係分類。';
    return;
  }
  const results = Array.isArray(result.results) ? result.results : [];
  if (!results.length) {
    elements.lookupStatus.textContent = result.message || '找不到符合的賓客。';
    return;
  }
  elements.lookupStatus.textContent = result.hasMore
    ? '找到前 ' + results.length + ' 筆，請再縮小分類或輸入姓名。'
    : '找到 ' + results.length + ' 筆，請確認姓名與關係分類。';
  results.forEach(guest => {
    const card = document.createElement('article');
    card.className = 'lookup-card';
    const categoryText = guest.category ? '關係分類 ' + guest.category : '關係分類未填寫';
    const tableText = guest.tableNo ? '桌號 ' + guest.tableNo : '桌號尚未分配';
    const checkInText = '點選查看最新紅包狀態';
    card.innerHTML = [
      '<div class="lookup-card-title">' + escapeHtml(guest.displayName || '未命名賓客') + '</div>',
      '<div class="lookup-card-meta">',
      '<span>' + escapeHtml(categoryText) + '</span>',
      '<span>' + escapeHtml(tableText) + '</span>',
      '<span>' + escapeHtml(checkInText) + '</span>',
      '</div>'
    ].join('');
    const actions = document.createElement('div');
    actions.className = 'lookup-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = !guest.guestId;
    button.textContent = guest.guestId ? '查看桌號／紅包' : '缺少賓客 ID';
    button.addEventListener('click', () => {
      queryGuest(guest.guestId, { source: 'lookup' });
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
  if (!settings.operator) {
    showResult('缺少操作人員', '請填寫操作人員姓名。', 'warn');
    return false;
  }
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

    operator: elements.operator.value.trim(),
    sessionToken: readSessionToken()
  };
}

async function saveSettings() {
  const settings = getSettings();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    apiUrl: settings.apiUrl,

    operator: settings.operator
  }));
  clearSessionToken();
  sessionPromise = null;
  updateConnectionStatus();
  return ensureSession();
}

function loadSettings() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const settings = JSON.parse(raw);
    elements.apiUrl.value = settings.apiUrl || '';
    elements.pin.value = '';

    elements.operator.value = settings.operator || '';

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiUrl: elements.apiUrl.value,

      operator: elements.operator.value
    }));
  } catch (err) {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

function readSessionToken() {
  const token = window.sessionStorage.getItem(SESSION_STORAGE_KEY) || '';
  const expiresAt = Number(window.sessionStorage.getItem(SESSION_EXPIRES_STORAGE_KEY) || 0);
  if (token && expiresAt && Date.now() >= expiresAt) {
    clearSessionToken();
    return '';
  }
  return token;
}

function clearSessionToken() {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
  window.sessionStorage.removeItem(GUEST_SNAPSHOT_STORAGE_KEY);
  guestSnapshot.clear();
}

function applyGuestSnapshot(guests) {
  guestSnapshot.clear();
  (Array.isArray(guests) ? guests : []).forEach(guest => rememberGuest(guest, false));
  window.sessionStorage.setItem(GUEST_SNAPSHOT_STORAGE_KEY,
    JSON.stringify(Array.from(guestSnapshot.values())));
}

function loadGuestSnapshot() {
  const raw = window.sessionStorage.getItem(GUEST_SNAPSHOT_STORAGE_KEY);
  if (!raw) return;
  try {
    applyGuestSnapshot(JSON.parse(raw));
  } catch (err) {
    window.sessionStorage.removeItem(GUEST_SNAPSHOT_STORAGE_KEY);
    guestSnapshot.clear();
  }
}

function rememberGuest(guest, persist = true) {
  if (!guest || !guest.ok || !guest.guestId) return;
  const stored = { ...guest };
  delete stored.localSnapshot;
  guestSnapshot.set(stored.guestId, stored);
  if (persist) {
    window.sessionStorage.setItem(GUEST_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(Array.from(guestSnapshot.values())));
  }
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
