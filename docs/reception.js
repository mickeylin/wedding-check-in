/* Exception receipts keep the original request across timeouts and reloads. */
(() => {
  const ids = ['partyMembers', 'partyNotes', 'partySize', 'partyAlert', 'guestDetails',
    'receptionPending',
    'receptionPendingText', 'receptionRetry', 'receptionNotice', 'receptionFeedback', 'extraEnvelopePanel',
    'extraEnvelopeType', 'extraEnvelopeSignature', 'extraEnvelopeNotes', 'receiveExtraButton', 'unlistedEnvelope'];
  const el = Object.fromEntries(ids.map(id => [id, document.querySelector('#' + id)]));
  const KEY = 'wedding-reception-operation-v1';
  let pending = null, busy = false, storageAvailable = true;
  let extraOpen = false, receiptSaved = false;
  const notice = (text, tone = 'warn') => {
    el.receptionNotice.textContent = text; el.receptionNotice.hidden = extraOpen;
    el.receptionNotice.dataset.tone = el.receptionFeedback.dataset.tone = tone;
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
    const formLocked = busy || !!pending || receiptSaved;
    el.receiveExtraButton.disabled = formLocked || !storageAvailable || !isBrowserOnline() || !extraOpen;
    el.receiveExtraButton.textContent = receiptSaved ? '這包已登記' : '登記這包（不填金額）';
    el.extraEnvelopeType.disabled = el.extraEnvelopeSignature.disabled = el.extraEnvelopeNotes.disabled = formLocked;
    if (typeof updateGiftButtons === 'function') updateGiftButtons();
  }
  function show(guest) {
    extraOpen = false; receiptSaved = false;
    el.extraEnvelopePanel.hidden = true;
    el.extraEnvelopeSignature.value = el.extraEnvelopeNotes.value = '';
    el.receptionFeedback.textContent = '';
    if (!pending && storageAvailable) el.receptionNotice.hidden = true;
    if (!guest) {
      el.partyMembers.textContent = el.partyNotes.textContent = '';
      el.partySize.textContent = el.partyAlert.textContent = '';
      el.partyAlert.hidden = true; el.guestDetails.open = false;
      controls(); return;
    }
    el.partyMembers.textContent = (guest.members || '') + (guest.partySize ? '\n本組 ' + guest.partySize + ' 人' : '');
    el.partySize.textContent = guest.partySize ? '本組 ' + guest.partySize + ' 人' : '';
    el.partyNotes.textContent = guest.notes || '';
    el.partyAlert.textContent = String(guest.notes || '').split(/[；\n]/)
      .filter(note => /兒童椅|嬰兒車|素食|撤.+椅|代領|核對|未確認|未知/.test(note)).join('；');
    el.partyAlert.hidden = !el.partyAlert.textContent;
    controls();
  }
  function open() {
    show(null);
    extraOpen = true;
    el.extraEnvelopePanel.hidden = false;
    el.extraEnvelopeType.value = '名單外';
    el.extraEnvelopeSignature.value = '';
    el.extraEnvelopeNotes.value = '';
    controls();
  }
  async function receiveExtra(data, label) {
    if (!extraOpen || busy || pending || receiptSaved || !storageAvailable) return;
    if (!isBrowserOnline()) { notice('目前離線，請使用紙本備援。'); return; }
    const operation = { action: 'receiveExtra', data, guestId: '', label, apiUrl: getSettings().apiUrl,
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
        action: 'receiveExtra', guestId: operation.guestId, sessionToken: token,
        requestId: operation.requestId, data: JSON.stringify(operation.data)
      });
      if (!result.ok) {
        if (['UNAUTHORIZED', 'INVALID_SESSION'].includes(result.status)) {
          handleUnauthorized(result.message); throw new Error('請原操作人員重新登入');
        }
        // Only explicit pre-write rejections are safe to remove. Unknown errors
        // and network failures retain the request because a write may exist.
        if (['BAD_REQUEST', 'NOT_FOUND'].includes(result.status)) {
          persist(null);
        }
        throw new Error(result.message || '結果尚未確認');
      }
      if (!result.record?.envelopeCode) throw new Error('尚未取得紅包編號，請核對原操作');
      if (!persist(null)) throw new Error('伺服器已處理，但本機無法清除待核對操作，請先人工核對');
      const repeated = operation.attempts > 1 || /REPLAY/.test(result.status);
      const code = result.record?.envelopeCode;
      receiptSaved = extraOpen;
      notice('例外紅包已登記。請在這包紅包寫上 ' + code + '，金額回家再清點。' +
        (repeated ? '這是原操作結果，請勿新增第二筆。' : ''), 'success');
    } catch (err) {
      notice(messageOf(err) + (pending ? '。原操作仍保留，請按「核對原操作結果／重試」，勿重複操作。' : ''));
    } finally { busy = false; controls(); }
  }
  el.receiveExtraButton.addEventListener('click', () => {
    if (!extraOpen || busy || pending || receiptSaved) return;
    const type = el.extraEnvelopeType.value, signature = el.extraEnvelopeSignature.value.trim();
    if (!signature) { notice('請先填紅包署名；無法確認可填「署名待確認」並備註。'); return; }
    if (!['名單外', '署名不同／代送'].includes(type)) { notice('請選擇名單外或代收紅包。'); return; }
    if (!window.confirm('確認收到另一包實體紅包？取得 E 編號前請將這包單獨放置。')) return;
    receiveExtra({ guestId: '',
      signature, exceptionType: type, state: '待清點', amount: '', notes: el.extraEnvelopeNotes.value.trim() }, '例外紅包：' + signature);
  });
  el.unlistedEnvelope.addEventListener('click', async () => {
    if (!(await openUnlistedGuest())) return;
    open(); el.extraEnvelopeSignature.focus();
  });
  el.receptionRetry.addEventListener('click', send);
  window.addEventListener('online', controls); window.addEventListener('offline', controls);
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    if (['cakeIssue', 'cakeCancel'].includes(saved?.action)) {
      if (persist(null)) notice('舊版發餅操作已停止同步，請依卡片及實際發放情況核對。');
    } else if (saved) {
      if (saved.action !== 'receiveExtra' || !saved.requestId || !saved.operator || !saved.apiUrl || !saved.data) {
        throw new Error('invalid operation');
      }
      pending = saved;
    }
  } catch (err) { storageAvailable = false; notice('待核對操作無法讀取，請人工核對後再使用。'); }
  function canLeave() {
    const hasDraft = el.extraEnvelopeSignature.value.trim() || el.extraEnvelopeNotes.value.trim();
    return !extraOpen || receiptSaved || !!pending || !hasDraft || window.confirm('這包紅包尚未登記，確定放棄輸入並返回？');
  }
  window.Reception = { show, open, isBusy: () => busy, canLeave };
  controls();
})();
