// Persist ordered arrays as individual records. JSON facade keeps old import/export formats compatible.
export const ITEM_STORE = 'items';
export const ORDER_PREFIX = 'collection-order:';
export function collectionRows(key, raw) {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('INVALID_ARRAY');
  const seen = new Map();
  return data.map((value, index) => {
    const identity = value && typeof value === 'object' ? value.id ?? value.date ?? value.english ?? value.japanese : value;
    const base = identity === undefined ? `position:${index}` : `value:${String(identity)}`;
    const n = seen.get(base) || 0; seen.set(base,n+1);
    return { collection:key, id:`${base}:${n}`, position:index, value };
  });
}
export function writeCollection(tx, key, raw) {
  const store = tx.objectStore(ITEM_STORE), kv = tx.objectStore('kv');
  const rows = raw === null ? [] : collectionRows(key,raw);
  const wanted = new Map(rows.map(({position, ...row}) => [row.id,row]));
  const cursor = store.index('collection').openCursor(IDBKeyRange.only(key));
  cursor.onsuccess = () => {
    const item = cursor.result;
    if (item) {
      const next = wanted.get(item.value.id);
      if (!next) item.delete();
      else { if (JSON.stringify(item.value) !== JSON.stringify(next)) item.update(next); wanted.delete(next.id); }
      item.continue();
    } else wanted.forEach(row => store.put(row));
  };
  cursor.onerror = () => tx.abort();
  kv.delete(key);
  if (raw === null) kv.delete(ORDER_PREFIX+key);
  else kv.put({ key:ORDER_PREFIX+key, value:JSON.stringify(rows.map(row => row.id)) });
}
export async function readCollections(db) {
  // Each transaction reads a bounded batch and closes before yielding to input/paint.
  const grouped = new Map(); let after;
  for (;;) {
    const rows = await new Promise((resolve,reject) => {
      const req = db.transaction(ITEM_STORE).objectStore(ITEM_STORE).getAll(after ? IDBKeyRange.lowerBound(after,true) : null, 300);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    rows.forEach(row => { if (!grouped.has(row.collection)) grouped.set(row.collection,[]); grouped.get(row.collection).push(row); });
    if (rows.length < 300) break;
    const last = rows.at(-1); after = [last.collection,last.id];
    await new Promise(resolve => setTimeout(resolve,0));
  }
  return grouped;
}
