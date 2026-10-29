/* Online cake issues and exception receipts retain the exact operation across
 * timeouts/reloads. Retrying never constructs a second request. */
(() => {
  const ids = ['partyMembers', 'partyNotes', 'cakePanel', 'cakeStatus', 'cakeRefresh',
    'cakeWestern', 'cakeChinese', 'cakeIssue', 'cakeHistory', 'receptionPending',
    'receptionPendingText', 'receptionRetry', 'receptionNotice', 'receptionFeedback', 'extraEnvelopePanel',
    'extraEnvelopeType', 'extraEnvelopeSignature', 'extraEnvelopeNotes', 'receiveExtraButton', 'unlistedEnvelope'];
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector('#' + id)]));
  const KEY = 'wedding-reception-operation-v1';
  let pending = null, busy = false, cake = null, generation = 0, storageAvailable = true, shownGuestId = null;
  const notice = text => {
    el.receptionNotice.textContent = text; el.receptionNotice.hidden = false;
    el.receptionFeedback.textContent = text;
  };
  function persist(value) {
    try {
      if (value) window.localStorage.setItem(KEY, JSON.stringify(value));
      else window.localStorage.removeItem(KEY);
      pending = value; return true;
    } catch (err) {
      storageAvailable = false;
      notice('無法安全保存操作。請暫停發餅及例外收件，改由固定一人用紙本記錄。');
      controls(); return false;
    }
  }
  function controls() {
    el.receptionPending.hidden = !pending && storageAvailable;
    el.receptionPendingText.textContent = pending
      ? pending.label + '：結果尚未核對，請勿重複發餅或新增同一包。原操作人員：' + pending.operator
      : '裝置儲存異常，請使用紙本備援。';
    el.receptionRetry.disabled = busy || !pending;
    el.cakeIssue.disabled = busy || !!pending || !storageAvailable || !cake || !isBrowserOnline();
    el.receiveExtraButton.disabled = busy || !!pending || !storageAvailable || !isBrowserOnline() || !selectedGuest;
    el.cakeRefresh.disabled = busy;
    el.cakeWestern.disabled = el.cakeChinese.disabled = busy;
    if (typeof updateGiftButtons === 'function') updateGiftButtons();
  }
  function renderCake(value) {
    cake = value;
    el.cakeHistory.replaceChildren();
    if (!value) { controls(); return; }
    const quantity = value => value == null ? '未確認' : String(value);
    el.cakeStatus.textContent = '共領：' + value.name + '（' + value.id + '）\n' +
      '整組配額：西式 ' + quantity(value.western) + '、中式 ' + quantity(value.chinese) + '\n' +
      '已領：西式 ' + value.issued.western + '、中式 ' + value.issued.chinese + '\n' +
      '尚可領：西式 ' + quantity(value.remaining.western) + '、中式 ' + quantity(value.remaining.chinese);
    el.cakeWestern.value = String(Math.max(0, value.remaining.western || 0));
    el.cakeChinese.value = String(Math.max(0, value.remaining.chinese || 0));
    (value.issues || []).forEach(record => {
      const row = document.createElement('p');
      row.textContent = (record.cancelled ? '已撤銷：' : '已登記發放：') + '西式 ' + record.western +
        '、中式 ' + record.chinese + '；由 ' + record.guestId + ' 領取，經手 ' + record.operator + ' ' + record.at;
      if (!record.cancelled) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary-button'; button.textContent = '更正這筆發放';
        button.disabled = busy || !!pending;
        button.addEventListener('click', () => {
          const reason = window.prompt('請填更正原因。撤銷只修正紀錄；請先確認實體喜餅已收回或原本未交付。');
          if (reason && reason.trim()) begin('cakeCancel', { originalId: record.id, reason: reason.trim() }, '喜餅發放更正');
        });
        row.append(button);
      }
      el.cakeHistory.append(row);
    });
    controls();
  }
  async function refresh() {
    const guest = selectedGuest, current = ++generation;
    cake = null; controls();
    if (!guest || !guest.cakeGroupId) {
      el.cakeStatus.textContent = '尚未設定喜餅共領單位；請人工核對，不自動發放。'; return;
    }
    if (!isBrowserOnline()) {
      el.cakeStatus.textContent = '目前離線，領餅狀態無法確認。由固定一人使用同一份紙本登記。'; return;
    }
    el.cakeStatus.textContent = '正在核對全家共領狀態…';
    try {
      const ready = await ensureSession();
      const token = ready ? readSessionToken() : '';
      if (!token) throw new Error('請先完成登入');
      const result = await jsonpRequest(getSettings(), { action: 'cakeStatus', guestId: guest.guestId, sessionToken: token });
      if (generation !== current || selectedGuest?.guestId !== guest.guestId) return;
      if (!result.ok) throw new Error(result.message || '無法讀取喜餅狀態');
      renderCake(result.cake);
    } catch (err) {
      if (generation === current) el.cakeStatus.textContent = '無法確認領餅狀態：' + messageOf(err) + '。請勿依舊畫面發餅。';
    }
  }
  function show(guest) {
    if (!guest) {
      shownGuestId = null; generation++; cake = null;
      el.partyMembers.textContent = el.partyNotes.textContent = el.receptionFeedback.textContent = '';
      el.cakePanel.hidden = el.extraEnvelopePanel.hidden = true;
      controls(); return;
    }
    const sameGuest = shownGuestId === guest.guestId;
    shownGuestId = guest.guestId;
    el.cakePanel.hidden = !guest.guestId; el.extraEnvelopePanel.hidden = false;
    el.partyMembers.textContent = (guest.members || '') + (guest.partySize ? '\n本組 ' + guest.partySize + ' 人' : '');
    el.partyNotes.textContent = guest.notes || '';
    // Ordinary envelope sync may re-render this same card while the operator
    // is entering cake quantities or labelling an E envelope. Preserve both.
    if (sameGuest) { controls(); return; }
    el.receptionFeedback.textContent = '';
    el.extraEnvelopePanel.open = false;
    el.extraEnvelopeType.value = guest.guestId ? '多包' : '名單外';
    el.extraEnvelopeSignature.value = '';
    el.extraEnvelopeNotes.value = '';
    renderCake(null); refresh();
  }
  async function begin(action, data, label) {
    if (busy || pending || !storageAvailable) return;
    if (!isBrowserOnline()) { notice('目前離線，請使用紙本備援。'); return; }
    const guestId = selectedGuest?.guestId || '';
    if (action !== 'receiveExtra' && !guestId) return;
    const operation = { action, data, guestId, label, apiUrl: getSettings().apiUrl,
      operator: readSessionOperator(), requestId: createRequestId(), attempts: 0 };
    if (!operation.operator) { notice('請先登入。'); return; }
    if (persist(operation)) await send();
  }
  async function send() {
    if (busy || !pending || !storageAvailable) return;
    if (getSettings().apiUrl !== pending.apiUrl || readSessionOperator() !== pending.operator) {
      notice('請使用原 API 與原操作人員重新登入，再核對原操作。'); return;
    }
    if (!isBrowserOnline()) { notice('目前離線，原操作已保留，恢復連線後再核對。'); return; }
    const operation = { ...pending, attempts: pending.attempts + 1 };
    if (!persist(operation)) return;
    busy = true; controls();
    try {
      const ready = await ensureSession();
      const token = ready ? readSessionToken() : '';
      if (!token || readSessionOperator() !== operation.operator || getSettings().apiUrl !== operation.apiUrl) {
        throw new Error('工作階段已變更，請原操作人員登入原 API 再核對');
      }
      const result = await jsonpRequest({ ...getSettings(), apiUrl: operation.apiUrl }, {
        action: operation.action, guestId: operation.guestId, sessionToken: token,
        requestId: operation.requestId, data: JSON.stringify(operation.data)
      });
      if (!result.ok) {
        if (['UNAUTHORIZED', 'INVALID_SESSION'].includes(result.status)) {
          handleUnauthorized(result.message); throw new Error('請原操作人員重新登入');
        }
        // Only explicit pre-write rejections are safe to remove. Unknown errors
        // and network failures retain the request because a write may exist.
        if (['BAD_REQUEST', 'NOT_FOUND', 'UNKNOWN_QUOTA', 'ALREADY_ISSUED', 'ALREADY_CANCELLED'].includes(result.status)) {
          persist(null);
        }
        throw new Error(result.message || '結果尚未確認');
      }
      if (!persist(null)) throw new Error('伺服器已處理，但本機無法清除待核對操作，請先人工核對');
      const repeated = operation.attempts > 1 || /REPLAY/.test(result.status);
      if (operation.action === 'receiveExtra') {
        const code = result.record?.envelopeCode;
        notice('例外紅包已登記。請在這包紅包寫上 ' + code + '，金額回家再清點。' +
          (repeated ? '這是原操作結果，請勿新增第二筆。' : ''));
        el.partyNotes.textContent = '這包紅包標記：' + code;
        // Keep the E code visible until the operator moves to the next guest.
        // A new lookup refreshes the envelope count from the server.
      } else {
        notice(operation.action === 'cakeCancel' ? '已更正發放紀錄。請依實體交付情況重新登記。'
          : repeated ? '原發餅操作已登記。請先核對是否已交付，勿再次拿餅。'
            : '發餅已確認：請交付西式 ' + operation.data.western + ' 盒、中式 ' + operation.data.chinese + ' 盒。');
        el.cakeStatus.textContent = el.receptionNotice.textContent;
        if (selectedGuest?.cakeGroupId === result.cake.id) renderCake(result.cake);
      }
    } catch (err) {
      notice(messageOf(err) + (pending ? '。原操作仍保留，請按「核對原操作結果／重試」，勿重新發放。' : ''));
    } finally { busy = false; controls(); }
  }
  el.cakeRefresh.addEventListener('click', refresh);
  el.cakeIssue.addEventListener('click', () => {
    const western = Number(el.cakeWestern.value), chinese = Number(el.cakeChinese.value);
    if (![western, chinese].every(n => Number.isSafeInteger(n) && n >= 0) || western + chinese < 1) {
      notice('請填有效盒數，至少一盒。'); return;
    }
    if (window.confirm('確認為「' + (cake?.name || '') + '」發放西式 ' + western + '、中式 ' + chinese + '？確認成功後才交餅。')) {
      begin('cakeIssue', { western, chinese }, '喜餅發放');
    }
  });
  el.receiveExtraButton.addEventListener('click', () => {
    const type = el.extraEnvelopeType.value, signature = el.extraEnvelopeSignature.value.trim();
    if (!signature) { notice('請先填紅包署名；無法確認可填「署名待確認」並備註。'); return; }
    if (type === '多包' && !selectedGuest?.guestId) { notice('第二包請先搜尋原賓客。'); return; }
    if (!window.confirm('確認收到另一包實體紅包？取得 E 編號前請將這包單獨放置。')) return;
    begin('receiveExtra', { guestId: type === '名單外' ? '' : selectedGuest?.guestId || '',
      signature, exceptionType: type, state: '待清點', amount: '', notes: el.extraEnvelopeNotes.value.trim() }, '例外紅包：' + signature);
  });
  el.unlistedEnvelope.addEventListener('click', () => {
    renderGiftResult({ ok: true, guestId: '', displayName: '名單外／代送紅包', giftState: '例外收件', canCancel: false });
    el.extraEnvelopePanel.open = true; el.extraEnvelopeSignature.focus();
  });
  el.receptionRetry.addEventListener('click', send);
  window.addEventListener('online', controls); window.addEventListener('offline', () => { renderCake(null); controls(); });
  try {
    pending = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (pending && (!pending.requestId || !pending.operator || !pending.apiUrl || !pending.action || !pending.data)) throw new Error('invalid operation');
  } catch (err) { storageAvailable = false; notice('待核對操作無法讀取，請人工核對後再使用。'); }
  window.Reception = { show, isBusy: () => busy, refresh };
  controls();
})();
