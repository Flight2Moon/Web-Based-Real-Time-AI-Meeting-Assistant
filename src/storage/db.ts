// Local-first storage (IndexedDB). Nothing here leaves the browser.
import type { Meeting, Segment } from '../types';

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

let dbp: Promise<IDBDatabase> | undefined;
const open = () => (dbp ??= (() => {
  const r = indexedDB.open('meeting-assistant', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('meetings', { keyPath: 'id' });
    r.result.createObjectStore('segments', { keyPath: 'id' }).createIndex('meetingId', 'meetingId');
  };
  return req(r);
})());

const store = async (name: string, mode: IDBTransactionMode = 'readonly') => (await open()).transaction(name, mode).objectStore(name);

export const db = {
  async meetings() { return ((await req((await store('meetings')).getAll())) as Meeting[]).sort((a, b) => b.createdAt - a.createdAt); },
  async putMeeting(m: Meeting) { await req((await store('meetings', 'readwrite')).put(m)); },
  async segments(meetingId: string) {
    return ((await req((await store('segments')).index('meetingId').getAll(meetingId))) as Segment[]).sort((a, b) => a.idx - b.idx);
  },
  async putSegment(s: Segment) { await req((await store('segments', 'readwrite')).put(s)); },
  async deleteMeeting(id: string) {
    const tx = (await open()).transaction(['meetings', 'segments'], 'readwrite');
    tx.objectStore('meetings').delete(id);
    const keys = await req(tx.objectStore('segments').index('meetingId').getAllKeys(id));
    for (const k of keys) tx.objectStore('segments').delete(k);
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  },
};
