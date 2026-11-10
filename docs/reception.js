/* Exception receipts and any pending operation from the previous version
 * keep the original request across timeouts and reloads. */
(() => {
  const ids = ['partyMembers', 'partyNotes', 'partySize', 'partyAlert', 'guestDetails',
    'receptionPending',
    'receptionPendingText', 'receptionRetry', 'receptionNotice', 'receptionFeedback', 'extraEnvelopePanel',
    'extraEnvelopeType', 'extraEnvelopeSignature', 'extraEnvelopeNotes', 'receiveExtraButton', 'unlistedEnvelope'];
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector('#' + id)]));
  const KEY = 'wedding-reception-operation-v1';
  let pending = null, busy = false, storageAvailable = true, shownGuestId = null;
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
      notice('無法安全保存操作。請暫停例外收件，改由固定一人用紙本記錄。');
      controls(); return false;
    }
  }
  function controls() {
    el.receptionPending.hidden = !pending && storageAvailable;
    el.receptionPendingText.textContent = pending
      ? pending.label + '：結果尚未核對，請勿重複操作。原操作人員：' + pending.operator
      : '裝置儲存異常，請使用紙本備援。';
    el.receptionRetry.disabled = busy || !pending;
    el.receiveExtraButton.disabled = busy || !!pending || !storageAvailable || !isBrowserOnline() || !selectedGuest;
    if (typeof updateGiftButtons === 'function') updateGiftButtons();
  }
  function show(guest) {
    if (!guest) {
      shownGuestId = null;
      el.partyMembers.textContent = el.partyNotes.textContent = el.receptionFeedback.textContent = '';
      el.partySize.textContent = el.partyAlert.textContent = '';
      el.partyAlert.hidden = true; el.guestDetails.open = false;
      el.extraEnvelopePanel.hidden = true;
      controls(); return;
    }
    const sameGuest = shownGuestId === guest.guestId;
    shownGuestId = guest.guestId;
    el.extraEnvelopePanel.hidden = false;
    el.partyMembers.textContent = (guest.members || '') + (guest.partySize ? '\n本組 ' + guest.partySize + ' 人' : '');
    el.partySize.textContent = guest.partySize ? '本組 ' + guest.partySize + ' 人' : '';
    el.partyNotes.textContent = guest.notes || '';
    el.partyAlert.textContent = String(guest.notes || '').split(/[；\n]/)
      .filter(note => /兒童椅|嬰兒車|素食|撤.+椅|代領|核對|未確認|未知/.test(note)).join('；');
    el.partyAlert.hidden = !el.partyAlert.textContent;
    // Background sync can re-render the card while an exception receipt is being entered.
    if (sameGuest) { controls(); return; }
    el.receptionFeedback.textContent = '';
    el.guestDetails.open = !guest.guestId;
    el.extraEnvelopePanel.open = false;
    el.extraEnvelopeType.value = guest.guestId ? '多包' : '名單外';
    el.extraEnvelopeSignature.value = '';
    el.extraEnvelopeNotes.value = '';
    controls();
  }
  async function receiveExtra(data, label) {
    if (busy || pending || !storageAvailable) return;
    if (!isBrowserOnline()) { notice('目前離線，請使用紙本備援。'); return; }
    const guestId = selectedGuest?.guestId || '';
    const operation = { action: 'receiveExtra', data, guestId, label, apiUrl: getSettings().apiUrl,
      operator: readSessionOperator(), requestId: createRequestId(), attempts: 0 };
    if (!operation.operator) { notice('請先登入。'); return; }
    if (persist(operation)) await send();
  }
  async function send() {
    if (busy || !pending || !storageAvailable) return;
    if (getSettings().apiUrl !== pending.apiUrl || readSessionOperator() !== pending.operator) {
      notice('請由原操作人員登入，並使用原帳本核對這筆紀錄。'); return;
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
        notice('舊版喜餅操作已核對。請確認實體交付情況。');
      }
    } catch (err) {
      notice(messageOf(err) + (pending ? '。原操作仍保留，請按「核對原操作結果／重試」，勿重複操作。' : ''));
    } finally { busy = false; controls(); }
  }
  el.receiveExtraButton.addEventListener('click', () => {
    const type = el.extraEnvelopeType.value, signature = el.extraEnvelopeSignature.value.trim();
    if (!signature) { notice('請先填紅包署名；無法確認可填「署名待確認」並備註。'); return; }
    if (type === '多包' && !selectedGuest?.guestId) { notice('第二包請先搜尋原賓客。'); return; }
    if (!window.confirm('確認收到另一包實體紅包？取得 E 編號前請將這包單獨放置。')) return;
    receiveExtra({ guestId: type === '名單外' ? '' : selectedGuest?.guestId || '',
      signature, exceptionType: type, state: '待清點', amount: '', notes: el.extraEnvelopeNotes.value.trim() }, '例外紅包：' + signature);
  });
  el.unlistedEnvelope.addEventListener('click', () => {
    renderGiftResult({ ok: true, guestId: '', displayName: '名單外／代送紅包', giftState: '例外收件', canCancel: false });
    el.extraEnvelopePanel.open = true; el.extraEnvelopeSignature.focus();
  });
  el.receptionRetry.addEventListener('click', send);
  window.addEventListener('online', controls); window.addEventListener('offline', controls);
  try {
    pending = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (pending && (!pending.requestId || !pending.operator || !pending.apiUrl || !pending.action || !pending.data)) throw new Error('invalid operation');
  } catch (err) { storageAvailable = false; notice('待核對操作無法讀取，請人工核對後再使用。'); }
  window.Reception = { show, isBusy: () => busy };
  controls();
})();
