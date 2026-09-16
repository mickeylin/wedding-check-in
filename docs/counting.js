/* Mobile counting: independent of the offline receipt queue. Never report an
 * unconfirmed money write as successful. Retain one immutable request to retry. */
(() => {
  const ids = ['receptionMode', 'countingMode', 'countingPanel', 'receptionScanner', 'receptionLookup',
    'countRefresh', 'countException', 'countStatus', 'countRetry', 'countEditor', 'countEditorTitle',
    'countReceiptInfo', 'countFields', 'countGuestId', 'countType', 'countSignature', 'countAmount',
    'countNotes', 'countReason', 'countComplete', 'countHold', 'countClose', 'countBrowser',
    'countSearch', 'countFilter', 'countSummary', 'countRecords'];
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector('#' + id)]));
  const STORAGE = 'wedding-gift-count-draft-v1';
  let records = [], selected = null, pending = null, busy = false, draft = null;
  let reading = false, loaded = false;
  const message = (text, tone = '') => {
    el.countStatus.textContent = text; el.countStatus.dataset.tone = tone;
  };
  function fields() {
    return { guestId: el.countGuestId.value.trim(), exceptionType: el.countType.value,
      signature: el.countSignature.value.trim(), amount: el.countAmount.value.trim(),
      notes: el.countNotes.value.trim(), reason: el.countReason.value.trim() };
  }
  function persist() {
    window.sessionStorage.setItem(STORAGE, JSON.stringify({ draft, pending }));
  }
  function controls() {
    el.countFields.disabled = busy || !!pending;
    el.countRefresh.disabled = busy || reading;
    el.countException.disabled = busy || !!pending;
    el.countRetry.hidden = !pending;
    el.countRetry.disabled = busy;
  }
  function fill(data) {
    for (const [key, id] of Object.entries({ guestId: 'countGuestId', exceptionType: 'countType',
      signature: 'countSignature', amount: 'countAmount', notes: 'countNotes', reason: 'countReason' })) {
      el[id].value = data[key] == null ? '' : String(data[key]);
    }
    el.countGuestId.disabled = !!(selected && selected.guestId);
  }
  function open(record, restored) {
    if (pending && !restored) return;
    if (!restored && draft && !window.confirm('放棄目前未儲存的清點內容？')) return;
    selected = record;
    draft = restored || { selected: record, values: record
      ? { ...record, signature: record.signature || record.displayName, reason: '' }
      : { guestId: '', signature: '', amount: '', exceptionType: '名單外', notes: '', reason: '' } };
    fill(draft.values);
    el.countEditor.hidden = false;
    el.countBrowser.hidden = true;
    el.countEditorTitle.textContent = record
      ? (record.state === '已清點' ? '更正清點：' : '清點：') + (record.envelopeCode || record.guestId)
      : '新增例外紅包';
    el.countReceiptInfo.textContent = record
      ? record.displayName + '・' + record.state + '\n收件：' + record.receivedBy + ' ' + record.receivedAt
        + (record.countedBy ? '\n上次清點：' + record.countedBy + ' ' + record.countedAt : '')
      : '新增代表另一包實體紅包。儲存成功後請將系統產生的 E 編號寫在袋上。';
    controls();
    el.countEditorTitle.focus();
    try { persist(); } catch (err) { message('無法保留草稿；請勿關閉分頁。', 'error'); }
  }
  function render() {
    const query = el.countSearch.value.trim().toLowerCase();
    const state = el.countFilter.value;
    const visible = records.filter(r => (!state || r.state === state) &&
      (!query || [r.envelopeCode, r.guestId, r.displayName, r.signature].some(v => String(v || '').toLowerCase().includes(query))));
    const total = records.filter(r => r.state === '已清點').reduce((sum, r) => sum + Math.round(Number(r.amount || 0) * 100), 0) / 100;
    el.countSummary.textContent = loaded
      ? '待清點 ' + records.filter(r => r.state === '待清點').length + ' 包・待核對 ' +
        records.filter(r => r.state === '待核對').length + ' 包・已清點總額 ' + total.toLocaleString('zh-TW') +
        '（上次載入）・符合 ' + visible.length + ' 包'
      : '尚未載入清點紀錄';
    el.countRecords.replaceChildren();
    if (loaded && !visible.length) {
      const hint = document.createElement('p');
      hint.textContent = '目前篩選沒有符合的紅包。可改選「全部」或重新載入；剛收件的紅包需先完成同步。';
      el.countRecords.append(hint);
    }
    visible.forEach(record => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'count-record'; button.disabled = !!pending || busy;
      const title = document.createElement('strong');
      title.textContent = (record.envelopeCode || record.guestId || '未編號') + '・' + (record.signature || record.displayName);
      const detail = document.createElement('span');
      detail.textContent = record.state + '・金額 ' + (record.amount === '' ? '尚未確認' : record.amount) +
        (record.exceptionType ? '・' + record.exceptionType : '') + '・收件 ' + record.receivedBy + ' ' + record.receivedAt;
      button.append(title, detail); button.addEventListener('click', () => open(record));
      el.countRecords.append(button);
    });
  }
  async function authenticate() {
    if (!isBrowserOnline()) { message('目前離線。輸入會留在本分頁，連線後再確認儲存。', 'error'); return false; }
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
      message(pending ? '上次儲存仍待確認，請按「確認上次儲存結果／重試」。'
        : draft ? '清單已更新；目前草稿仍保留。如有衝突，返回清單重新選取。' : '清單已更新，請依紅包上的編號查找。');
    } catch (err) { message(messageOf(err), 'error'); }
    finally { reading = false; controls(); }
  }
  async function save(state) {
    if (busy || pending) return;
    const value = fields();
    if (value.amount && !/^\d{1,9}(\.\d{1,2})?$/.test(value.amount)) { message('金額需為非負數，最多九位整數及兩位小數。', 'error'); return; }
    if (state === '已清點' && (!value.signature || value.amount === '')) { message('請填署名與金額；未知金額請留白並選待核對。', 'error'); return; }
    if (state === '待核對' && !value.notes) { message('請填待核對原因。', 'error'); return; }
    if (!selected && !value.exceptionType) { message('新增紅包請選例外狀況。', 'error'); return; }
    if (!selected && value.exceptionType === '多包' && !value.guestId) { message('第二包需填原賓客編號。', 'error'); return; }
    if (selected && selected.state === '已清點' && !value.reason) { message('請填更正原因。', 'error'); return; }
    draft = { selected, values: value };
    try { persist(); } catch (err) { message('無法保存重試資料，請先修復瀏覽器儲存空間。', 'error'); return; }
    // Lock the editor before asynchronous login so a double tap cannot create two operations.
    busy = true; controls();
    try {
      if (!(await authenticate())) return;
      if (!window.confirm((selected ? '紅包 ' + (selected.envelopeCode || selected.guestId) : '新增一包例外紅包') +
        '\n署名：' + (value.signature || '待確認') + '\n金額：' + (value.amount === '' ? '未知' : value.amount) +
        '\n狀態：' + state + '\n確認儲存？')) return;
      pending = { requestId: createRequestId(), operator: readSessionOperator(), apiUrl: getSettings().apiUrl,
        data: { ...value, receiptId: selected ? selected.receiptId : '', version: selected ? selected.version : '', state } };
      try { persist(); } catch (err) {
        pending = null; message('無法保存重試資料，尚未送出。', 'error'); return;
      }
    } finally { busy = false; controls(); }
    if (pending) await sendPending();
  }
  async function sendPending() {
    if (!pending || busy) return;
    busy = true; controls();
    try {
      if (!(await authenticate())) return;
      if (readSessionOperator() !== pending.operator || getSettings().apiUrl !== pending.apiUrl) {
        message('請使用原操作人員「' + pending.operator + '」及原帳本網址重新登入後確認。', 'error'); return;
      }
      message('正在確認儲存，請保留此分頁…');
      const data = await jsonpRequest(getSettings(), { action: 'countSave', sessionToken: readSessionToken(),
        requestId: pending.requestId, data: JSON.stringify(pending.data) });
      if (data && data.ok && ['COUNT_SAVED', 'COUNT_REPLAY'].includes(data.status) && data.record) {
        const record = data.record;
        // The reception snapshot predates this edit; fetch fresh status next time.
        if (record.guestId && typeof guestSnapshot !== 'undefined') {
          guestSnapshot.delete(record.guestId);
          try { window.sessionStorage.setItem(GUEST_SNAPSHOT_STORAGE_KEY, JSON.stringify(Array.from(guestSnapshot.values()))); }
          catch (err) { /* Server validation remains authoritative if cache persistence fails. */ }
        }
        records = records.filter(r => r.receiptId !== record.receiptId);
        if (record.state !== '已撤銷') records.push(record);
        pending = null; draft = null; selected = null;
        let storageWarning = '';
        try { window.sessionStorage.removeItem(STORAGE); }
        catch (err) { storageWarning = '\n草稿清除失敗；重新開啟時請先核對已儲存紀錄。'; }
        el.countEditor.hidden = true; el.countBrowser.hidden = false; render();
        message('已確認：' + (record.envelopeCode || record.guestId) + '・' + record.state +
          (record.amount === '' ? '・金額尚未確認' : '・金額 ' + record.amount) +
          (record.envelopeCode ? '\n請在實體紅包上寫「' + record.envelopeCode + '」。' : '') +
          '\n可以處理下一包。' + storageWarning, 'success');
        el.countSearch.focus();
        return;
      }
      if (data && data.status === 'UNAUTHORIZED') {
        handleUnauthorized(data.message); message('登入已過期。請以原人員重新登入，再確認上次儲存結果。', 'error'); return;
      }
      if (data && ['BAD_REQUEST', 'CONFLICT', 'REQUEST_REUSED'].includes(data.status)) {
        pending = null; persist();
        message(data.message + '。草稿仍保留；衝突時請返回清單，重新載入並核對。', 'error'); return;
      }
      throw new Error(data && data.message || '尚未取得儲存確認');
    } catch (err) {
      message(messageOf(err) + '。尚未確認完成；請保留分頁並按重試，勿另新增同一包。', 'error');
    } finally { busy = false; controls(); render(); }
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
    if (counting && !loaded && !draft && !pending) await refresh();
  }
  el.countingMode.addEventListener('click', () => mode(true));
  el.receptionMode.addEventListener('click', () => mode(false));
  el.countRefresh.addEventListener('click', refresh);
  el.countException.addEventListener('click', () => open(null));
  el.countEditor.addEventListener('submit', event => { event.preventDefault(); save('已清點'); });
  el.countHold.addEventListener('click', () => save('待核對'));
  el.countRetry.addEventListener('click', sendPending);
  el.countSearch.addEventListener('input', render);
  el.countFilter.addEventListener('change', render);
  el.countEditor.addEventListener('input', () => {
    if (pending) return;
    draft = { selected, values: fields() };
    try { persist(); } catch (err) { message('無法保留草稿；請勿關閉分頁。', 'error'); }
  });
  el.countClose.addEventListener('click', () => {
    if (busy || pending || !window.confirm('返回清單會放棄未儲存的清點內容，確定？')) return;
    draft = null; selected = null; persist();
    el.countEditor.hidden = true; el.countBrowser.hidden = false; render();
  });
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(STORAGE) || 'null');
    if (saved) {
      pending = saved.pending || null; draft = saved.draft || null;
      if (draft) { selected = draft.selected; open(selected, draft); }
      if (pending || draft) {
        mode(true);
        message(pending ? '有一筆儲存結果待確認，請重新登入後按重試。' : '已還原上次未儲存的草稿。');
      }
    }
  } catch (err) { message('無法讀取清點草稿，請先核對帳本後再操作。', 'error'); }
  controls(); render();
})();
