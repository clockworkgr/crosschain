/**
 * A record is immutable once stored: the live cache, the undo log and the
 * callers that hold one all point at the same object, so a change in place
 * would corrupt every one of them. Freezing reaches every nested object and
 * array. Byte arrays cannot be frozen in JavaScript, so a record's hashes
 * and keys remain the one thing a caller must not write into.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const v of Array.isArray(value) ? value : Object.values(value)) deepFreeze(v);
  return value;
}
