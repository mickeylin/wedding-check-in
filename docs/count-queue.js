(function exposeCountQueueModel(root) {
  'use strict';

  const PENDING = new Set(['queued', 'syncing', 'retry_wait', 'needs_login']);
  const BLOCKING = new Set([...PENDING, 'attention']);
  const COMPLETED = new Set(['synced', 'resolved']);

  const copy = items => (Array.isArray(items) ? items : []).map(item => ({ ...item }));

  function recover(items) {
    return copy(items).map(item => item.status === 'syncing'
      ? { ...item, status: 'retry_wait', lastError: '上次同步結果未確認，將沿用同一請求編號重試' }
      : item);
  }

  function findForReceipt(items, receiptId) {
    if (!receiptId) return null;
    return (Array.isArray(items) ? items : []).find(item =>
      item.data && item.data.receiptId === receiptId && BLOCKING.has(item.status)) || null;
  }

  function enqueue(items, input) {
    const current = copy(items);
    if (!input || !input.requestId || !input.operator || !input.apiUrl || !input.data) {
      return { ok: false, reason: 'INVALID_INPUT', items: current };
    }
    const existing = findForReceipt(current, input.data.receiptId);
    if (existing) return { ok: false, reason: 'DUPLICATE_LOCAL', existing, items: current };
    const item = {
      requestId: String(input.requestId), operator: String(input.operator), apiUrl: String(input.apiUrl),
      label: String(input.label || input.data.receiptId || '例外紅包'), data: { ...input.data },
      status: 'queued', attempts: 0, savedAt: Number(input.savedAt) || Date.now(), syncedAt: 0,
      lastError: '', serverRecord: null
    };
    current.push(item);
    return { ok: true, item, items: compact(current) };
  }

  const update = (items, requestId, patch) => copy(items)
    .map(item => item.requestId === requestId ? { ...item, ...patch } : item);
  const nextSyncable = items => (Array.isArray(items) ? items : [])
    .find(item => item.status === 'queued' || item.status === 'retry_wait') || null;

  function summary(items) {
    const values = Array.isArray(items) ? items : [];
    return {
      pending: values.filter(item => PENDING.has(item.status)).length,
      attention: values.filter(item => item.status === 'attention').length,
      completed: values.filter(item => COMPLETED.has(item.status)).length
    };
  }

  function compact(items, keepCompleted = 50) {
    const values = copy(items);
    const completed = values.map((item, index) => COMPLETED.has(item.status) ? index : -1).filter(index => index >= 0);
    const remove = new Set(completed.slice(0, Math.max(0, completed.length - keepCompleted)));
    return values.filter((item, index) => !remove.has(index));
  }

  root.CountQueueModel = { recover, findForReceipt, enqueue, update, nextSyncable, summary, compact };
})(typeof window !== 'undefined' ? window : globalThis);
