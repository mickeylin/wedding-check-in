const STORAGE_KEY = 'wedding-check-in-settings';
const SESSION_STORAGE_KEY = 'wedding-check-in-session-token';
const SESSION_EXPIRES_STORAGE_KEY = 'wedding-check-in-session-expires-at';
const SESSION_OPERATOR_STORAGE_KEY = 'wedding-check-in-session-operator';
const GUEST_SNAPSHOT_STORAGE_KEY = 'wedding-check-in-guest-snapshot';
const GIFT_QUEUE_STORAGE_KEY = 'wedding-check-in-gift-queue-v1';
const DUPLICATE_SCAN_COOLDOWN_MS = 2500;
const GIFT_QUEUE_RETRY_DELAYS_MS = [3000, 10000, 30000];
const API_REQUEST_TIMEOUT_MS = 20000;

const elements = {
  settingsPanel: document.querySelector('#settingsPanel'),
  settingsHint: document.querySelector('#settingsHint'),
  operatorStatus: document.querySelector('#operatorStatus'),
  reader: document.querySelector('#reader'),
  guestFacts: document.querySelector('#guestFacts'),
  guestTable: document.querySelector('#guestTable'),
  guestCode: document.querySelector('#guestCode'),
  queueDetails: document.querySelector('#queueDetails'),
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
elements.giftQueueSummary = document.querySelector('#giftQueueSummary');
elements.giftQueueList = document.querySelector('#giftQueueList');
elements.retryGiftQueueButton = document.querySelector('#retryGiftQueueButton');
elements.clearCompletedGiftQueueButton = document.querySelector('#clearCompletedGiftQueueButton');
let selectedGuest = null;
let giftBusy = false;
const guestSnapshot = new Map();
const giftQueueModel = window.GiftQueueModel;
let giftQueue = [];
let giftQueueStorageAvailable = true;
let giftQueueSyncPromise = null;
let giftQueueRetryTimer = null;
let giftQueuePauseReason = '';

elements.receiveButton.addEventListener('click', () => mutateGift('receive'));
elements.cancelReceiptButton.addEventListener('click', () => {
  if (selectedGuest && window.confirm('撤銷 ' + selectedGuest.displayName + ' 的待清點收件？')) mutateGift('cancel');
});
elements.retryGiftQueueButton.addEventListener('click', retryGiftQueueNow);
elements.clearCompletedGiftQueueButton.addEventListener('click', clearCompletedGiftQueue);
elements.giftQueueList.addEventListener('click', event => {
  const button = event.target.closest('[data-resolve-request]');
  if (!button) return;
  resolveGiftQueueAttention(button.dataset.resolveRequest);
});

let scanner = null;
let isScanning = false;
let sessionPromise = null;

const recentGuestIdScanAt = new Map();
const checkinGate = window.CheckinGate.create();
let shouldResumeScannerAfterGate = false;
let guestReturnFocus = null;

loadSettings();
loadGiftQueue();
loadGuestSnapshot();
renderGiftQueue();
updateConnectionStatus();
elements.settingsPanel.open = !readSessionToken();
scheduleGiftQueueSync(0);

if (typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    renderGiftQueue();
    updateConnectionStatus();
    scheduleGiftQueueSync(0);
  });
  window.addEventListener('offline', () => { renderGiftQueue(); updateConnectionStatus(); });
  window.addEventListener('keydown', event => {
    if (elements.checkinModal.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); continueToNextGuest(); }
    if (event.key !== 'Tab') return;
    const targets = Array.from(elements.checkinModal.querySelectorAll('button:not([hidden]):not(:disabled), summary'));
    if (!targets.length) return;
    const index = targets.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) {
      event.preventDefault(); targets[targets.length - 1].focus();
    } else if (!event.shiftKey && (index === -1 || index === targets.length - 1)) {
      event.preventDefault(); targets[0].focus();
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== GIFT_QUEUE_STORAGE_KEY) return;
    loadGiftQueue();
    renderGiftQueue();
    scheduleGiftQueueSync(0);
  });
}

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
    elements.reader.hidden = false;
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
    elements.reader.hidden = true;
    showResult('無法啟動相機', messageOf(err), 'error');
  }
}

async function stopScanner() {
  if (!scanner || !isScanning) return;
  try {
    await scanner.stop();
  } finally {
    isScanning = false;
    elements.reader.hidden = true;
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
  guestReturnFocus = document.activeElement;
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
      const data = { ...applyLocalGiftState(cached), ok: true, localSnapshot: true };
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
      window.sessionStorage.setItem(SESSION_OPERATOR_STORAGE_KEY, data.operator || settings.operator);
      if (Array.isArray(data.guests)) applyGuestSnapshot(data.guests);
      if (giftQueue.length) resumeGiftQueueAfterLogin();
      elements.settingsPanel.open = false;
      updateConnectionStatus();
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

async function jsonpSession(settings) {
  const request = {
    action: 'session',
    pin: settings.pin,
    operator: settings.operator,
    includeGuestSnapshot: '1'
  };

  try {
    return await jsonpRequest(settings, request);
  } catch (err) {
    if (!isRetryableSessionError(err)) throw err;
    return jsonpRequest(settings, request);
  }
}

function isRetryableSessionError(err) {
  const message = messageOf(err);
  return message === 'API 回應逾時' || message === 'API 載入失敗';
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
    }, API_REQUEST_TIMEOUT_MS);

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
  const wasOpen = !elements.checkinModal.hidden;
  checkinGate.complete();
  elements.checkinModalCard.className = 'checkin-modal-card ' + (tone || 'neutral');
  elements.checkinModalTitle.textContent = title;
  elements.checkinModalMessage.textContent = message || '';
  elements.checkinModal.hidden = false;
  elements.guestFacts.hidden = !selectedGuest;
  document.querySelector('main').inert = true;
  document.querySelector('header').inert = true;
  document.body?.classList?.add('guest-open');
  if (!wasOpen) elements.checkinModalTitle.focus();
}

function updateGiftButtons() {
  elements.receiveButton.hidden = !selectedGuest || selectedGuest.giftState !== '未收件';
  elements.cancelReceiptButton.hidden = !selectedGuest || !selectedGuest.canCancel;
  elements.receiveButton.disabled = giftBusy;
  elements.cancelReceiptButton.disabled = giftBusy;
  elements.nextGuestButton.disabled = giftBusy;
  elements.nextGuestButton.textContent = selectedGuest && selectedGuest.giftState === '未收件'
    ? '只查桌號／下一位' : '下一位';
  if (!elements.checkinModal.hidden && [elements.receiveButton, elements.cancelReceiptButton]
    .some(button => button.hidden && document.activeElement === button)) {
    elements.nextGuestButton.focus();
  }
}

function renderGiftResult(data) {
  if (!data || !data.ok) {
    selectedGuest = null;
    if (data && data.status === 'UNAUTHORIZED') handleUnauthorized(data.message);
    updateGiftButtons();
    openCheckinGate('請重新查詢', data && data.message || '無法取得資料', 'error');
    return;
  }
  selectedGuest = applyLocalGiftState(data);
  elements.guestTable.textContent = selectedGuest.tableNo || '未分配';
  elements.guestCode.textContent = selectedGuest.guestId;
  const detail = ['紅包：' + selectedGuest.giftState,
    selectedGuest.giftState === '未收件' ? '收到實體紅包後，請按「收到紅包」；只查桌號可直接下一位。' : selectedGuest.message || ''].join('\n');
  const tone = selectedGuest.giftState === '未收件' ? 'neutral'
    : selectedGuest.giftState === '待同步' ? 'warn'
      : selectedGuest.giftState === '待核對' ? 'error' : 'success';
  openCheckinGate(selectedGuest.displayName, detail, tone);
  elements.resultBox.hidden = true;
  updateGiftButtons();
}

async function mutateGift(action) {
  if (giftBusy || !selectedGuest) return;
  const guest = selectedGuest;
  if (action === 'receive') {
    queueGiftReceipt(guest);
    return;
  }
  const operationStarted = Date.now();
  giftBusy = true;
  updateGiftButtons();
  elements.checkinModalMessage.textContent = '正在撤銷收件，請稍候確認結果…';
  try {
    const data = await jsonpRequest(getSettings(), { action, guestId: guest.guestId,
      receiptId: guest.receiptId, sessionToken: readSessionToken(), requestId: createRequestId() });
    if (data && data.ok && (data.status === 'CANCELLED' || data.status === 'ALREADY_CANCELLED')) {
      markGiftQueueCancelled(guest.guestId, guest.receiptId);
    }
    rememberGuest(data);
    recordGiftTiming('撤銷', operationStarted, data);
    renderGiftResult(data);
    if (data && data.ok) addRecent(data.status, guest.guestId, guest.displayName + '：' + data.message);
  } catch (err) {
    recordGiftTiming('操作失敗', operationStarted, null);
    selectedGuest = null;
    openCheckinGate('撤銷狀態待確認', messageOf(err) + '。可能已撤銷；請按下一位後重新查詢，核對狀態再操作。', 'error');
  } finally {
    giftBusy = false;
    updateGiftButtons();
  }
}

function queueGiftReceipt(guest) {
  const started = Date.now();
  const settings = getSettings();
  if (!giftQueueStorageAvailable) {
    openCheckinGate('手機無法保存', '這筆紅包沒有安全記錄，請勿直接處理下一位；請重新整理或改用人工備案。', 'error');
    return false;
  }
  const queued = giftQueueModel.enqueue(giftQueue, {
    requestId: createRequestId(),
    guestId: guest.guestId,
    displayName: guest.displayName,
    tableNo: guest.tableNo,
    operator: readSessionOperator() || settings.operator,
    savedAt: Date.now()
  });
  if (!queued.ok) {
    const existing = queued.existing;
    const message = existing && existing.status === 'attention'
      ? '這位賓客已有待核對紀錄，請先把實體紅包放入待核對區。'
      : '這位賓客已保存在手機或已完成同步，不會新增第二筆。';
    openCheckinGate('未新增重複收件', message, existing && existing.status === 'attention' ? 'error' : 'warn');
    return false;
  }
  if (!persistGiftQueue(queued.items)) {
    openCheckinGate('手機保存失敗', '這筆紅包沒有安全記錄，請勿直接處理下一位；請重新整理或改用人工備案。', 'error');
    return false;
  }

  const localGuest = applyLocalGiftState({ ...guest, message: '' });
  rememberGuest(localGuest);
  renderGiftResult(localGuest);
  addRecent('WAITING_SYNC', guest.guestId, guest.displayName + '：已保存在手機，等待同步');
  elements.timingStatus.textContent = '本機保存：' + ((Date.now() - started) / 1000).toFixed(2) + ' 秒\n尚未寫入 Google Sheet；背景同步狀態請看主畫面。';
  scheduleGiftQueueSync(0);
  return true;
}

function applyLocalGiftState(guest) {
  if (!guest || !guest.guestId || !giftQueueModel) return guest;
  const item = giftQueueModel.findForGuest(giftQueue, guest.guestId);
  if (!item) return guest;
  if (item.status === 'attention') {
    return { ...guest, giftState: '待核對', canCancel: false,
      message: '另一支手機或既有紀錄已先收件。請把實體紅包放入待核對區，到 Google Sheet 核對。' };
  }
  if (['queued', 'syncing', 'retry_wait', 'needs_login'].includes(item.status)) {
    return { ...guest, giftState: '待同步', canCancel: false,
      message: queueStatusLabel(item) + '；資料已安全保存在這支手機，可以處理下一位。請確認紅包已寫上賓客編號 ' + guest.guestId + '。' };
  }
  if (item.status === 'synced') {
    return { ...guest, giftState: guest.giftState === '未收件' ? '待清點' : guest.giftState,
      receiptId: item.receiptId || guest.receiptId, canCancel: !!(item.receiptId || guest.receiptId) };
  }
  if (item.status === 'resolved') {
    return { ...guest, giftState: '待清點', canCancel: false,
      message: '撞單已人工核對；如需更正請直接到 Google Sheet。' };
  }
  return guest;
}

function loadGiftQueue() {
  if (!giftQueueModel) {
    giftQueueStorageAvailable = false;
    giftQueue = [];
    return;
  }
  try {
    const raw = window.localStorage.getItem(GIFT_QUEUE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    giftQueue = giftQueueModel.recover(parsed);
    giftQueueStorageAvailable = true;
    if (raw && JSON.stringify(parsed) !== JSON.stringify(giftQueue)) {
      window.localStorage.setItem(GIFT_QUEUE_STORAGE_KEY, JSON.stringify(giftQueue));
    }
  } catch (err) {
    giftQueueStorageAvailable = false;
    giftQueue = [];
  }
}

function persistGiftQueue(items) {
  if (!giftQueueModel) return false;
  const compacted = giftQueueModel.compact(items);
  try {
    window.localStorage.setItem(GIFT_QUEUE_STORAGE_KEY, JSON.stringify(compacted));
    giftQueue = compacted;
    giftQueueStorageAvailable = true;
    renderGiftQueue();
    updateConnectionStatus();
    return true;
  } catch (err) {
    giftQueueStorageAvailable = false;
    renderGiftQueue();
    updateConnectionStatus();
    return false;
  }
}

function queueStatusLabel(item) {
  return ({
    queued: '待同步',
    syncing: '同步中',
    retry_wait: '同步失敗，等待重試',
    needs_login: '等待重新登入',
    attention: '需要人工核對',
    synced: '已同步',
    resolved: '已人工結案',
    cancelled: '已撤銷'
  })[item && item.status] || '狀態未知';
}

function renderGiftQueue() {
  if (!elements.giftQueueSummary || !elements.giftQueueList || !giftQueueModel) return;
  const summary = giftQueueModel.summary(giftQueue);
  if (summary.attention || !giftQueueStorageAvailable) elements.queueDetails.open = true;
  const offlinePrefix = isBrowserOnline() ? '' : '目前離線；';
  if (!giftQueueStorageAvailable) {
    elements.giftQueueSummary.textContent = '手機儲存異常：不可安全收新紅包';
  } else if (summary.attention) {
    elements.giftQueueSummary.textContent = offlinePrefix + summary.attention + ' 筆待核對，' + summary.pending + ' 筆待同步';
  } else if (summary.pending) {
    elements.giftQueueSummary.textContent = offlinePrefix + summary.pending + ' 筆尚未進入 Google Sheet' +
      (giftQueuePauseReason ? '；' + giftQueuePauseReason : '');
  } else {
    elements.giftQueueSummary.textContent = offlinePrefix + '沒有待同步紀錄';
  }
  elements.retryGiftQueueButton.disabled = !giftQueueStorageAvailable || !summary.pending || !!giftQueueSyncPromise;
  elements.clearCompletedGiftQueueButton.hidden = !summary.completed;

  const visible = giftQueue.slice(-12).reverse();
  elements.giftQueueList.innerHTML = visible.map(item => {
    const tone = item.status === 'attention' ? 'attention'
      : ['synced', 'resolved', 'cancelled'].includes(item.status) ? 'synced' : 'pending';
    const error = item.lastError ? '<small>' + escapeHtml(item.lastError) + '</small>' : '';
    const resolve = item.status === 'attention'
      ? '<button type="button" data-resolve-request="' + escapeHtml(item.requestId) + '">已核對，解除警示</button>' : '';
    return '<li class="sync-item ' + tone + '">' +
      '<strong>' + escapeHtml(item.displayName) + '（' + escapeHtml(item.guestId) + '）：' + escapeHtml(queueStatusLabel(item)) + '</strong>' +
      '<small>收件人員：' + escapeHtml(item.operator) + '・嘗試 ' + Number(item.attempts || 0) + ' 次・' +
      escapeHtml(new Date(item.savedAt).toLocaleTimeString()) + '</small>' + error + resolve + '</li>';
  }).join('');
}

function isBrowserOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function scheduleGiftQueueSync(delayMs) {
  if (!giftQueueModel || !giftQueueModel.summary(giftQueue).pending) return;
  if (giftQueueRetryTimer && typeof window.clearTimeout === 'function') {
    window.clearTimeout(giftQueueRetryTimer);
  }
  if (typeof window.setTimeout !== 'function') return;
  giftQueueRetryTimer = window.setTimeout(() => {
    giftQueueRetryTimer = null;
    kickGiftQueue();
  }, Math.max(0, Number(delayMs) || 0));
}

function kickGiftQueue() {
  if (giftQueueSyncPromise) return giftQueueSyncPromise;
  giftQueueSyncPromise = drainGiftQueue()
    .catch(err => {
      showResult('背景同步異常', messageOf(err) + '；本機紀錄仍保留。', 'error');
    })
    .finally(() => {
      giftQueueSyncPromise = null;
      renderGiftQueue();
      updateConnectionStatus();
    });
  renderGiftQueue();
  return giftQueueSyncPromise;
}

async function drainGiftQueue() {
  while (giftQueueStorageAvailable) {
    const item = giftQueueModel.nextSyncable(giftQueue);
    if (!item) return;
    if (!isBrowserOnline()) {
      renderGiftQueue();
      return;
    }

    const settings = getSettings();
    const sessionToken = readSessionToken();
    const sessionOperator = readSessionOperator();
    if (!settings.apiUrl || !sessionToken || sessionOperator !== item.operator) {
      giftQueuePauseReason = sessionOperator && sessionOperator !== item.operator
        ? '請以原收件人員「' + item.operator + '」重新登入後同步'
        : '請輸入 PIN 並重新登入後同步';
      renderGiftQueue();
      return;
    }

    giftQueuePauseReason = '';
    const syncing = { status: 'syncing', attempts: Number(item.attempts || 0) + 1, lastError: '' };
    if (!persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, syncing))) return;
    const syncStartedAt = Date.now();
    let data;
    try {
      data = await jsonpRequest(settings, {
        action: 'receive',
        guestId: item.guestId,
        sessionToken,
        requestId: item.requestId
      });
    } catch (err) {
      const current = giftQueue.find(entry => entry.requestId === item.requestId) || { ...item, ...syncing };
      persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
        status: 'retry_wait',
        lastError: messageOf(err) + '；將用同一請求編號重試'
      }));
      const retryDelay = GIFT_QUEUE_RETRY_DELAYS_MS[Math.min(Math.max(0, current.attempts - 1), GIFT_QUEUE_RETRY_DELAYS_MS.length - 1)];
      scheduleGiftQueueSync(retryDelay);
      return;
    }

    if (data && data.ok && (data.status === 'RECEIVED' || data.status === 'REPLAY')) {
      persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
        status: 'synced',
        syncedAt: Date.now(),
        receiptId: data.receiptId || '',
        lastError: ''
      }));
      rememberGuest(data);
      if (selectedGuest && selectedGuest.guestId === item.guestId) {
        renderGiftResult(data);
        recordGiftTiming('背景收件同步', syncStartedAt, data);
      }
      addRecent(data.status, item.guestId, item.displayName + '：已同步至 Google Sheet');
      continue;
    }

    if (data && data.status === 'ALREADY_RECEIVED') {
      persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
        status: 'attention',
        receiptId: data.receiptId || '',
        lastError: 'Google Sheet 已有另一筆收件；請隔離實體紅包並人工核對'
      }));
      rememberGuest(applyLocalGiftState(data));
      if (selectedGuest && selectedGuest.guestId === item.guestId) {
        renderGiftResult(data);
        recordGiftTiming('背景收件撞單', syncStartedAt, data);
      }
      addRecent('ATTENTION', item.guestId, item.displayName + '：另一支手機可能已收件，需核對');
      continue;
    }

    if (data && data.status === 'UNAUTHORIZED') {
      clearSessionToken();
      persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
        status: 'needs_login',
        lastError: '工作階段已過期，請重新登入'
      }));
      showResult('工作階段已過期', '本機收件沒有遺失；重新登入後按「立即重試」。', 'warn');
      return;
    }

    if (data && (data.retryable || data.status === 'BUSY')) {
      const current = giftQueue.find(entry => entry.requestId === item.requestId) || { ...item, ...syncing };
      persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
        status: 'retry_wait',
        lastError: (data.message || '後端忙碌') + '；將自動重試'
      }));
      const retryDelay = GIFT_QUEUE_RETRY_DELAYS_MS[Math.min(Math.max(0, current.attempts - 1), GIFT_QUEUE_RETRY_DELAYS_MS.length - 1)];
      scheduleGiftQueueSync(retryDelay);
      return;
    }

    persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, {
      status: 'attention',
      lastError: data && data.message || '伺服器回應無法確認，請人工核對'
    }));
    addRecent('ATTENTION', item.guestId, item.displayName + '：同步結果需人工核對');
  }
}

async function retryGiftQueueNow() {
  if (!validateSettings()) return;
  if (!readSessionToken() && !(await ensureSession())) return;
  resumeGiftQueueAfterLogin();
  await kickGiftQueue();
}

function resumeGiftQueueAfterLogin() {
  const operator = readSessionOperator();
  giftQueuePauseReason = '';
  const resumed = giftQueue.map(item => item.status === 'needs_login' && item.operator === operator
    ? { ...item, status: 'queued', lastError: '' } : item);
  persistGiftQueue(resumed);
  scheduleGiftQueueSync(0);
}

function resolveGiftQueueAttention(requestId) {
  const item = giftQueue.find(entry => entry.requestId === requestId && entry.status === 'attention');
  if (!item || !window.confirm('已在 Google Sheet 核對 ' + item.displayName + '，並處理好實體紅包嗎？')) return;
  persistGiftQueue(giftQueueModel.update(giftQueue, requestId, { status: 'resolved', lastError: '' }));
  const cached = guestSnapshot.get(item.guestId);
  if (cached) rememberGuest(applyLocalGiftState(cached));
  if (selectedGuest && selectedGuest.guestId === item.guestId) renderGiftResult(selectedGuest);
}

function clearCompletedGiftQueue() {
  if (!window.confirm('只清除這支手機上已同步、已撤銷及人工結案的顯示紀錄？Google Sheet 不受影響。')) return;
  persistGiftQueue(giftQueue.filter(item => !['synced', 'resolved', 'cancelled'].includes(item.status)));
}

function markGiftQueueCancelled(guestId, receiptId) {
  const item = giftQueue.find(entry => entry.guestId === guestId && entry.status === 'synced'
    && (!receiptId || !entry.receiptId || entry.receiptId === receiptId));
  if (!item) return;
  persistGiftQueue(giftQueueModel.update(giftQueue, item.requestId, { status: 'cancelled' }));
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
  document.querySelector('main').inert = false;
  document.querySelector('header').inert = false;
  document.body?.classList?.remove('guest-open');
  checkinGate.reset();

  try {
    if (resumeScanner) {
      await startScanner();
      elements.stopButton.focus();
    } else {
      (guestReturnFocus && guestReturnFocus.isConnected ? guestReturnFocus : elements.manualGuestId).focus();
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
  if (!validateSettings()) return false;
  const settings = getSettings();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiUrl: settings.apiUrl,

      operator: settings.operator
    }));
  } catch (err) {
    giftQueueStorageAvailable = false;
    renderGiftQueue();
    updateConnectionStatus();
    showResult('手機儲存不可用', '無法安全保存設定與離線收件，請更換瀏覽器或改用緊急備案。', 'error');
    return false;
  }
  clearSessionToken();
  sessionPromise = null;
  updateConnectionStatus();
  return ensureSession();
}

function loadSettings() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw);
    elements.apiUrl.value = settings.apiUrl || '';
    elements.pin.value = '';

    elements.operator.value = settings.operator || '';

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      apiUrl: elements.apiUrl.value,

      operator: elements.operator.value
    }));
  } catch (err) {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (removeError) {}
  }
}

function readSessionToken() {
  const token = window.sessionStorage.getItem(SESSION_STORAGE_KEY) || '';
  const expiresAt = Number(window.sessionStorage.getItem(SESSION_EXPIRES_STORAGE_KEY) || 0);
  const operator = window.sessionStorage.getItem(SESSION_OPERATOR_STORAGE_KEY) || '';
  if (token && (!operator || (expiresAt && Date.now() >= expiresAt))) {
    clearSessionToken();
    return '';
  }
  return token;
}

function readSessionOperator() {
  return window.sessionStorage.getItem(SESSION_OPERATOR_STORAGE_KEY) || '';
}

function clearSessionToken() {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_EXPIRES_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_OPERATOR_STORAGE_KEY);
  window.sessionStorage.removeItem(GUEST_SNAPSHOT_STORAGE_KEY);
  guestSnapshot.clear();
}

function applyGuestSnapshot(guests) {
  reconcileGiftQueueWithSnapshot(guests);
  guestSnapshot.clear();
  (Array.isArray(guests) ? guests : []).forEach(guest => rememberGuest(guest, false));
  window.sessionStorage.setItem(GUEST_SNAPSHOT_STORAGE_KEY,
    JSON.stringify(Array.from(guestSnapshot.values())));
}

function reconcileGiftQueueWithSnapshot(guests) {
  if (!giftQueueModel || !giftQueue.length) return;
  const byGuestId = new Map((Array.isArray(guests) ? guests : []).map(guest => [guest.guestId, guest]));
  let changed = false;
  const reconciled = giftQueue.map(item => {
    const guest = byGuestId.get(item.guestId);
    if (guest && guest.giftState === '未收件' && (item.status === 'synced' || item.status === 'resolved')) {
      changed = true;
      return { ...item, status: 'cancelled', lastError: '' };
    }
    return item;
  });
  if (changed) persistGiftQueue(reconciled);
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
  const stored = { ...applyLocalGiftState(guest) };
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
  const loggedIn = !!readSessionToken();
  elements.operatorStatus.textContent = loggedIn ? readSessionOperator() + '・已登入' : '尚未登入';
  elements.settingsHint.textContent = loggedIn ? '已登入・需要更新名單時展開' : '請登入下載名單';
  if (!giftQueueStorageAvailable) {
    elements.connectionStatus.textContent = '手機儲存異常';
    return;
  }
  const summary = giftQueueModel ? giftQueueModel.summary(giftQueue) : { pending: 0, attention: 0 };
  if (!isBrowserOnline()) {
    elements.connectionStatus.textContent = summary.pending ? '離線・' + summary.pending + ' 筆待同步' : '目前離線';
  } else if (summary.attention) {
    elements.connectionStatus.textContent = summary.attention + ' 筆待核對';
  } else if (summary.pending) {
    elements.connectionStatus.textContent = summary.pending + ' 筆待同步';
  } else {
    elements.connectionStatus.textContent = loggedIn ? '同步正常' : '尚未登入';
  }
}

function showResult(title, message, tone) {
  elements.resultBox.hidden = false;
  if (!readSessionToken()) elements.settingsPanel.open = true;
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
