/* Mobile counting is local-first. A confirmed form is durably queued on this
 * device, then sent in the background with one immutable request id. */
(() => {
  const ids = ['receptionMode', 'countingMode', 'countingPanel', 'receptionScanner', 'receptionLookup',
    'countRefresh', 'countException', 'countStatus', 'countRetry', 'countQueueSection', 'countQueueSummary', 'countQueueList',
    'countEditor', 'countEditorTitle', 'countReceiptInfo', 'countFields', 'countGuestGroup', 'countGuestId',
    'countType', 'countSignature', 'countAmount', 'countNotesLabel', 'countNotes', 'countReasonGroup',
    'countReason', 'countFormError', 'countComplete', 'countHold',
    'countClose', 'countBrowser', 'countSearch', 'countFilter', 'countSummary', 'countRecords'];
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector('#' + id)]));
  const DRAFT_STORAGE = 'wedding-gift-count-draft-v1';
  const QUEUE_STORAGE = 'wedding-gift-count-queue-v1';
  const RETRY_DELAYS = [5000, 15000, 30000];
  const queueModel = window.CountQueueModel;
  let records = [], queue = [], selected = null, draft = null;
  let initialValues = null;
  let busy = false, reading = false, loaded = false, queueStorageAvailable = true;
  let syncPromise = null, retryTimer = null;

  const message = (text, tone = '') => {
    el.countStatus.textContent = text; el.countStatus.dataset.tone = tone;
  };
  const fields = () => ({ guestId: el.countGuestId.value.trim(), exceptionType: el.countType.value,
    signature: el.countSignature.value.trim(), amount: el.countAmount.value.trim(),
    notes: el.countNotes.value.trim(), reason: el.countReason.value.trim() });
  const valuesFor = record => record
    ? { guestId: String(record.guestId || ''), exceptionType: String(record.exceptionType || ''),
      signature: String(record.signature || record.displayName || ''),
      amount: record.amount === '' || record.amount == null ? '' : String(record.amount),
      notes: String(record.notes || ''), reason: '' }
    : { guestId: '', signature: '', amount: '', exceptionType: '名單外', notes: '', reason: '' };
  const normalizedValues = value => Object.fromEntries(
    ['guestId', 'exceptionType', 'signature', 'amount', 'notes', 'reason']
      .map(key => [key, String(value && value[key] != null ? value[key] : '').trim()]));
  const formChanged = () => JSON.stringify(normalizedValues(fields())) !== JSON.stringify(normalizedValues(initialValues));
  const queueSummary = () => queueModel ? queueModel.summary(queue) : { pending: 0, attention: 0, completed: 0 };

  function persistDraft() {
    if (draft) window.sessionStorage.setItem(DRAFT_STORAGE, JSON.stringify({ draft }));
    else window.sessionStorage.removeItem(DRAFT_STORAGE);
  }
  function persistQueue(next) {
    if (!queueModel) return false;
    try {
      queue = queueModel.compact(next);
      window.localStorage.setItem(QUEUE_STORAGE, JSON.stringify(queue));
      queueStorageAvailable = true;
      renderQueue();
      return true;
    } catch (err) {
      queueStorageAvailable = false;
      message('手機無法保存清點佇列；尚未送出，請先修復瀏覽器儲存空間。', 'error');
      renderQueue();
      return false;
    }
  }
  function controls() {
    el.countFields.disabled = busy;
    el.countRefresh.disabled = busy || reading;
    el.countException.disabled = busy || !queueStorageAvailable;
    const summary = queueSummary();
    el.countRetry.hidden = !summary.pending;
    el.countRetry.disabled = !!syncPromise || !summary.pending;
  }
  function fill(data) {
    for (const [key, id] of Object.entries({ guestId: 'countGuestId', exceptionType: 'countType',
      signature: 'countSignature', amount: 'countAmount', notes: 'countNotes', reason: 'countReason' })) {
      el[id].value = data[key] == null ? '' : String(data[key]);
    }
    el.countGuestId.disabled = !!(selected && selected.guestId);
  }
  function clearFormError() {
    el.countFormError.textContent = ''; el.countFormError.hidden = true;
    [el.countGuestId, el.countType, el.countSignature, el.countAmount, el.countNotes, el.countReason]
      .forEach(field => field.setAttribute('aria-invalid', 'false'));
  }
  function fieldError(text, field) {
    el.countFormError.textContent = text; el.countFormError.hidden = false;
    if (field) {
      field.setAttribute('aria-invalid', 'true'); field.focus();
      if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  function configureForm(record) {
    el.countGuestGroup.hidden = !!(record && record.guestId);
    el.countReasonGroup.hidden = !(record && record.state === '已清點');
    el.countNotesLabel.textContent = '備註（選填）';
    clearFormError();
  }
  function open(record, restored) {
    if (record && queueModel.findForReceipt(queue, record.receiptId)) {
      message('這包已有待同步清點，請先處理其他包。', 'error'); return;
    }
    if (!restored && draft && formChanged() && !window.confirm('放棄目前未儲存的清點內容？')) return;
    selected = record;
    const baseline = valuesFor(record);
    initialValues = normalizedValues(restored && restored.initialValues || baseline);
    draft = restored
      ? { ...restored, initialValues }
      : { selected: record, values: baseline, initialValues };
    fill(draft.values);
    configureForm(record);
    message('');
    el.countEditor.hidden = false; el.countBrowser.hidden = true;
    el.countEditorTitle.textContent = record
      ? (record.state === '已清點' ? '更正清點：' : '清點：') + (record.envelopeCode || record.guestId)
      : '新增例外紅包';
    el.countReceiptInfo.textContent = record
      ? record.displayName + '・' + record.state + '\n收件：' + record.receivedBy + ' ' + record.receivedAt
        + (record.countedBy ? '\n上次清點：' + record.countedBy + ' ' + record.countedAt : '')
      : '新增代表另一包實體紅包。同步成功取得 E 編號前，請將這包隔離。';
    controls(); el.countEditorTitle.focus();
    try { persistDraft(); } catch (err) { fieldError('無法保留草稿；請勿關閉分頁。'); }
  }
  function render() {
    const query = el.countSearch.value.trim().toLowerCase();
    const state = el.countFilter.value;
    const visible = records.filter(record => (!state || record.state === state) &&
      (!query || [record.envelopeCode, record.guestId, record.displayName, record.signature]
        .some(value => String(value || '').toLowerCase().includes(query))));
    const total = records.filter(record => record.state === '已清點')
      .reduce((sum, record) => sum + Math.round(Number(record.amount || 0) * 100), 0) / 100;
    el.countSummary.textContent = loaded
      ? '待清點 ' + records.filter(record => record.state === '待清點').length + ' 包・待核對 ' +
        records.filter(record => record.state === '待核對').length + ' 包・已清點總額 ' +
        total.toLocaleString('zh-TW')
      : '尚未載入清點紀錄';
    el.countRecords.replaceChildren();
    if (loaded && !visible.length) {
      const hint = document.createElement('p');
      hint.textContent = '目前篩選沒有符合的紅包。可改選「全部」或重新載入；剛收件的紅包需先完成同步。';
      el.countRecords.append(hint);
    }
    visible.forEach(record => {
      const pending = queueModel.findForReceipt(queue, record.receiptId);
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'count-record'; button.disabled = !!pending || busy;
      const title = document.createElement('strong');
      title.textContent = (record.envelopeCode || record.guestId || '未編號') + '・' + (record.signature || record.displayName);
      const detail = document.createElement('span');
      detail.textContent = record.state + '・金額 ' + (record.amount === '' ? '尚未確認' : record.amount) +
        (record.exceptionType ? '・' + record.exceptionType : '') +
        (pending ? '・清點' + queueStatusLabel(pending) : '');
      button.append(title, detail); button.addEventListener('click', () => open(record));
      el.countRecords.append(button);
    });
    controls();
  }
  function queueStatusLabel(item) {
    return ({ queued: '待同步', syncing: '同步中', retry_wait: '等待重試', needs_login: '等待登入',
      attention: '需要核對', synced: '已同步', resolved: '已人工核對' })[item.status] || item.status;
  }
  function renderQueue() {
    const summary = queueSummary();
    el.countQueueSection.hidden = queueStorageAvailable && !summary.pending && !summary.attention;
    el.countQueueSummary.textContent = !queueStorageAvailable ? '手機儲存異常：不可安全清點新紅包'
      : summary.attention ? summary.attention + ' 筆需核對，' + summary.pending + ' 筆待同步'
        : summary.pending ? summary.pending + ' 筆已保存在手機、尚未進入 Google Sheet'
          : '沒有待同步清點';
    el.countQueueList.replaceChildren();
    queue.filter(item => !['synced', 'resolved'].includes(item.status)).slice(-20).reverse().forEach(item => {
      const row = document.createElement('li');
      const title = document.createElement('strong');
      const serverCode = item.serverRecord && item.serverRecord.envelopeCode;
      title.textContent = (serverCode || item.label) + '：' + queueStatusLabel(item);
      const detail = document.createElement('small');
      detail.textContent = '清點人員：' + item.operator + '・嘗試 ' + Number(item.attempts || 0) + ' 次' +
        (item.lastError ? '・' + item.lastError : '');
      row.append(title, detail);
      if (item.status === 'attention') {
        const resolve = document.createElement('button');
        resolve.type = 'button'; resolve.className = 'secondary-button compact-button';
        resolve.textContent = '已人工核對，移除待辦';
        resolve.addEventListener('click', () => {
          if (!window.confirm('請先核對 Google Sheet、GiftAudit 與實體紅包。確定這筆已人工處理？')) return;
          persistQueue(queueModel.update(queue, item.requestId, { status: 'resolved', lastError: '' }));
          render();
        });
        row.append(resolve);
      }
      el.countQueueList.append(row);
    });
    controls();
  }
  async function authenticate() {
    if (!isBrowserOnline()) { message('目前離線；清點會保留在手機，連線後再同步。', 'error'); return false; }
    if (!validateSettings() || !(await ensureSession())) {
      message('請先展開登入與設定，登入後再回到清點。', 'error'); return false;
    }
    return true;
  }
  async function refresh() {
    if (busy || reading) return;
    reading = true; controls();
    try {
      if (!(await authenticate())) return;
      message('正在載入最新紅包清單…');
      const data = await jsonpRequest(getSettings(), { action: 'countList', sessionToken: readSessionToken() });
      if (!data || !data.ok || !Array.isArray(data.records)) {
        if (data && data.status === 'UNAUTHORIZED') handleUnauthorized(data.message);
        throw new Error(data && data.message || '清點功能尚未部署，請更新 Apps Script');
      }
      records = data.records; loaded = true; render();
      message(queueSummary().pending ? '清單已更新；本機仍有清點在背景同步。' : '清單已更新，請依紅包上的編號查找。');
    } catch (err) { message(messageOf(err), 'error'); }
    finally { reading = false; controls(); }
  }
  async function save(state) {
    if (busy) return;
    const value = fields();
    clearFormError();
    el.countNotesLabel.textContent = state === '待核對' ? '待核對原因（必填）' : '備註（選填）';
    if (value.amount && !/^\d{1,9}(\.\d{1,2})?$/.test(value.amount)) {
      fieldError('金額需為非負數，最多九位整數及兩位小數。', el.countAmount); return;
    }
    if (state === '已清點' && !value.signature) { fieldError('請填紅包署名。', el.countSignature); return; }
    if (state === '已清點' && value.amount === '') {
      fieldError('請填金額；未知金額請改選「記錄為待核對」。', el.countAmount); return;
    }
    if (state === '待核對' && !value.notes) { fieldError('請填待核對原因。', el.countNotes); return; }
    if (!selected && !value.exceptionType) { fieldError('新增紅包請選例外狀況。', el.countType); return; }
    if (!selected && value.exceptionType === '多包' && !value.guestId) {
      fieldError('第二包需填原賓客編號。', el.countGuestId); return;
    }
    if (selected && selected.state === '已清點' && !value.reason) {
      fieldError('請填更正原因。', el.countReason); return;
    }
    draft = { selected, values: value };
    try { persistDraft(); } catch (err) { fieldError('無法保存草稿，請先修復瀏覽器儲存空間。'); return; }
    busy = true; controls();
    try {
      if (!queueModel) { fieldError('清點功能尚未完整載入，請重新整理頁面。'); return; }
      if (!validateSettings()) { fieldError('請先完成登入與設定，再保存清點。'); return; }
      const settings = getSettings();
      const operator = readSessionOperator();
      if (!settings.apiUrl || !operator) { fieldError('請先完成登入，再保存清點。'); return; }
      if (!window.confirm((selected ? '紅包 ' + (selected.envelopeCode || selected.guestId) : '新增一包例外紅包') +
        '\n署名：' + (value.signature || '待確認') + '\n金額：' + (value.amount === '' ? '未知' : value.amount) +
        '\n狀態：' + state + '\n確認保存到手機並背景同步？')) return;
      const data = { ...value, receiptId: selected ? selected.receiptId : '',
        version: selected ? selected.version : '', state };
      const added = queueModel.enqueue(queue, { requestId: createRequestId(), operator, apiUrl: settings.apiUrl,
        label: selected ? (selected.envelopeCode || selected.guestId) : (value.signature || '例外紅包'), data });
      if (!added.ok) {
        fieldError(added.reason === 'DUPLICATE_LOCAL' ? '這包已有待同步清點，請勿重複送出。' : '無法建立清點待辦。');
        return;
      }
      if (!persistQueue(added.items)) {
        fieldError('手機無法保存清點資料，尚未送出。請檢查瀏覽器儲存空間。'); return;
      }
      draft = null; selected = null; initialValues = null;
      try { persistDraft(); } catch (err) { /* Queue is already durable and authoritative. */ }
      el.countEditor.hidden = true; el.countBrowser.hidden = false; render();
      const offline = !isBrowserOnline() ? '目前離線；' : '';
      message(offline + (data.receiptId ? '已保存，背景同步中。可繼續下一包。'
        : '已保存；取得 E 編號前請隔離這包。'), 'success');
    } finally { busy = false; controls(); render(); }
    kickQueue();
  }
  function scheduleQueue(delay) {
    if (!queueSummary().pending || typeof window.setTimeout !== 'function') return;
    if (retryTimer && typeof window.clearTimeout === 'function') window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => { retryTimer = null; kickQueue(); }, delay);
  }
  function kickQueue() {
    if (syncPromise) return syncPromise;
    syncPromise = drainQueue().finally(() => { syncPromise = null; renderQueue(); render(); });
    renderQueue();
    return syncPromise;
  }
  function applyServerRecord(record) {
    if (record.guestId && typeof guestSnapshot !== 'undefined') {
      guestSnapshot.delete(record.guestId);
      try { window.sessionStorage.setItem(GUEST_SNAPSHOT_STORAGE_KEY, JSON.stringify(Array.from(guestSnapshot.values()))); }
      catch (err) { /* Server validation remains authoritative. */ }
    }
    records = records.filter(item => item.receiptId !== record.receiptId);
    if (record.state !== '已撤銷') records.push(record);
  }
  async function drainQueue() {
    while (queueStorageAvailable) {
      const item = queueModel.nextSyncable(queue);
      if (!item || !isBrowserOnline()) return;
      const settings = getSettings();
      const token = readSessionToken();
      const operator = readSessionOperator();
      if (!token || settings.apiUrl !== item.apiUrl || operator !== item.operator) {
        message(operator && operator !== item.operator
          ? '待同步清點屬於原操作人員「' + item.operator + '」，請用該人員重新登入後重試。'
          : '待同步清點需要重新登入後重試。', 'error');
        return;
      }
      const attempts = Number(item.attempts || 0) + 1;
      if (!persistQueue(queueModel.update(queue, item.requestId, { status: 'syncing', attempts, lastError: '' }))) return;
      let data;
      try {
        data = await jsonpRequest(settings, { action: 'countSave', sessionToken: token,
          requestId: item.requestId, data: JSON.stringify(item.data) });
      } catch (err) {
        persistQueue(queueModel.update(queue, item.requestId, { status: 'retry_wait',
          lastError: messageOf(err) + '；保留同一請求編號重試' }));
        scheduleQueue(RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        return;
      }
      if (data && data.ok && ['COUNT_SAVED', 'COUNT_REPLAY'].includes(data.status) && data.record) {
        applyServerRecord(data.record);
        persistQueue(queueModel.update(queue, item.requestId, { status: 'synced', syncedAt: Date.now(),
          lastError: '', serverRecord: data.record }));
        message('已同步：' + (data.record.envelopeCode || data.record.guestId) + '・' + data.record.state +
          (data.record.envelopeCode ? '\n請立即在隔離的實體紅包寫「' + data.record.envelopeCode + '」。' : ''), 'success');
        render();
        continue;
      }
      if (data && data.status === 'UNAUTHORIZED') {
        handleUnauthorized(data.message);
        persistQueue(queueModel.update(queue, item.requestId, { status: 'needs_login', lastError: '登入已過期，請重新登入' }));
        return;
      }
      if (data && (data.retryable || data.status === 'BUSY')) {
        persistQueue(queueModel.update(queue, item.requestId, { status: 'retry_wait',
          lastError: (data.message || '後端忙碌') + '；將自動重試' }));
        scheduleQueue(RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)]);
        return;
      }
      persistQueue(queueModel.update(queue, item.requestId, { status: 'attention',
        lastError: data && data.message || '同步結果無法確認，請依 GiftAudit 與實體紅包核對' }));
    }
  }
  async function retryNow() {
    if (!(await authenticate())) return;
    const operator = readSessionOperator();
    persistQueue(queue.map(item => item.status === 'needs_login' && item.operator === operator
      ? { ...item, status: 'queued', lastError: '' } : item));
    await kickQueue();
  }
  async function mode(counting) {
    if (counting) {
      if (!elements.checkinModal.hidden) { message('請先完成目前接待。'); return; }
      await stopScanner();
    }
    el.countingPanel.hidden = !counting;
    el.receptionScanner.hidden = counting; el.receptionLookup.hidden = counting;
    el.countingMode.setAttribute('aria-pressed', String(counting));
    el.receptionMode.setAttribute('aria-pressed', String(!counting));
    el.countingMode.className = counting ? '' : 'secondary-button';
    el.receptionMode.className = counting ? 'secondary-button' : '';
    if (counting && !loaded && !draft) await refresh();
  }

  el.countingMode.addEventListener('click', () => mode(true));
  el.receptionMode.addEventListener('click', () => mode(false));
  el.countRefresh.addEventListener('click', refresh);
  el.countException.addEventListener('click', () => open(null));
  el.countEditor.addEventListener('submit', event => { event.preventDefault(); save('已清點'); });
  el.countHold.addEventListener('click', () => save('待核對'));
  el.countRetry.addEventListener('click', retryNow);
  el.countSearch.addEventListener('input', render);
  el.countFilter.addEventListener('change', render);
  el.countEditor.addEventListener('input', () => {
    clearFormError();
    draft = { selected, values: fields(), initialValues };
    try { persistDraft(); } catch (err) { fieldError('無法保留草稿；請勿關閉分頁。'); }
  });
  el.countClose.addEventListener('click', () => {
    if (busy || (formChanged() && !window.confirm('尚未儲存修改，確定返回紅包清單？'))) return;
    draft = null; selected = null; initialValues = null; persistDraft();
    el.countEditor.hidden = true; el.countBrowser.hidden = false; render();
    el.countSearch.focus();
  });

  try {
    if (!queueModel) throw new Error('清點佇列程式未載入');
    queue = queueModel.recover(JSON.parse(window.localStorage.getItem(QUEUE_STORAGE) || '[]'));
    window.localStorage.setItem(QUEUE_STORAGE, JSON.stringify(queue));
  } catch (err) {
    queue = []; queueStorageAvailable = false;
    message('無法讀取清點佇列；不可安全清點新紅包。', 'error');
  }
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(DRAFT_STORAGE) || 'null');
    if (saved && saved.pending && queueStorageAvailable) {
      const migrated = queueModel.enqueue(queue, { ...saved.pending,
        label: saved.pending.data && (saved.pending.data.guestId || saved.pending.data.signature) });
      if (migrated.ok) persistQueue(migrated.items);
      window.sessionStorage.removeItem(DRAFT_STORAGE);
    } else if (saved && saved.draft) {
      draft = saved.draft; selected = draft.selected; open(selected, draft);
      mode(true); message('已還原上次未儲存的草稿。');
    }
  } catch (err) { message('無法讀取清點草稿，請先核對帳本後再操作。', 'error'); }
  renderQueue(); controls(); render();
  if (queueSummary().pending) kickQueue();
})();
