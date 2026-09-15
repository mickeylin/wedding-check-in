(function exposeGiftQueueModel(root) {
  'use strict';

  const BLOCKING_STATUSES = new Set([
    'queued', 'syncing', 'retry_wait', 'needs_login', 'attention', 'synced', 'resolved'
  ]);
  const PENDING_STATUSES = new Set(['queued', 'syncing', 'retry_wait', 'needs_login']);
  const COMPLETED_STATUSES = new Set(['synced', 'resolved', 'cancelled']);

  function copy(items) {
    return (Array.isArray(items) ? items : []).map(item => ({ ...item }));
  }

  function recover(items) {
    return copy(items).map(item => item.status === 'syncing'
      ? { ...item, status: 'retry_wait', lastError: '上次同步結果未確認，將用同一請求編號重試' }
      : item);
  }

  function findForGuest(items, guestId) {
    return (Array.isArray(items) ? items : []).find(item =>
      item.guestId === guestId && BLOCKING_STATUSES.has(item.status)) || null;
  }

  function enqueue(items, input) {
    const current = copy(items);
    const guestId = String(input && input.guestId || '').trim();
    if (!guestId || !input.requestId || !input.operator) {
      return { ok: false, reason: 'INVALID_INPUT', items: current };
    }
    const existing = findForGuest(current, guestId);
    if (existing) {
      return { ok: false, reason: 'DUPLICATE_LOCAL', existing, items: current };
    }
    const item = {
      requestId: String(input.requestId),
      guestId,
      displayName: String(input.displayName || guestId),
      tableNo: String(input.tableNo || ''),
      operator: String(input.operator),
      status: 'queued',
      attempts: 0,
      savedAt: Number(input.savedAt) || Date.now(),
      syncedAt: 0,
      receiptId: '',
      lastError: ''
    };
    current.push(item);
    return { ok: true, item, items: compact(current) };
  }

  function update(items, requestId, patch) {
    return copy(items).map(item => item.requestId === requestId ? { ...item, ...patch } : item);
  }

  function nextSyncable(items) {
    return (Array.isArray(items) ? items : []).find(item =>
      item.status === 'queued' || item.status === 'retry_wait') || null;
  }

  function summary(items) {
    const counts = {};
    (Array.isArray(items) ? items : []).forEach(item => {
      counts[item.status] = (counts[item.status] || 0) + 1;
    });
    return {
      counts,
      pending: (Array.isArray(items) ? items : []).filter(item => PENDING_STATUSES.has(item.status)).length,
      attention: counts.attention || 0,
      completed: (Array.isArray(items) ? items : []).filter(item => COMPLETED_STATUSES.has(item.status)).length
    };
  }

  function compact(items, keepCompleted = 100) {
    const current = copy(items);
    const completedIndexes = current
      .map((item, index) => COMPLETED_STATUSES.has(item.status) ? index : -1)
      .filter(index => index !== -1);
    const removeCount = Math.max(0, completedIndexes.length - keepCompleted);
    const remove = new Set(completedIndexes.slice(0, removeCount));
    return current.filter((item, index) => !remove.has(index));
  }

  root.GiftQueueModel = {
    recover,
    findForGuest,
    enqueue,
    update,
    nextSyncable,
    summary,
    compact
  };
})(typeof window !== 'undefined' ? window : globalThis);
