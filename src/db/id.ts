/**
 * Object identity, Graphene style: every object has a type and an instance
 * number, and the pair is its id. Instances come from a per-type counter and
 * are never reused, so the objects of one type sit at 0, 1, 2, ... This is
 * what lets the primary index be a plain array and the Merkle tree a plain
 * complete binary tree (merkle.ts): no hashing of keys, no balancing.
 *
 * The two halves pack into one u64 (16 bits of type, 48 of instance) for the
 * wire, for hashing, and for use as a Map key. Objects reference each other
 * by id. For a chain whose public keys are 1312 bytes that matters: a
 * transfer names its accounts in 16 bytes and the keys stay in state.
 */
export const MAX_TYPE = 0xffff;
export const INSTANCE_BITS = 48n;
export const MAX_INSTANCE = 2 ** 48 - 1;
const INSTANCE_MASK = (1n << INSTANCE_BITS) - 1n;

export type ObjectId = bigint;

export function objectId(type: number, instance: number): ObjectId {
  if (!Number.isInteger(type) || type < 0 || type > MAX_TYPE) throw new RangeError(`bad object type ${type}`);
  if (!Number.isInteger(instance) || instance < 0 || instance > MAX_INSTANCE) throw new RangeError(`bad instance ${instance}`);
  return (BigInt(type) << INSTANCE_BITS) | BigInt(instance);
}

export function typeOf(id: ObjectId): number {
  return Number(id >> INSTANCE_BITS);
}

/** Instances are below 2^48, so a plain number is exact and indexes an array. */
export function instanceOf(id: ObjectId): number {
  return Number(id & INSTANCE_MASK);
}

export function idToString(id: ObjectId): string {
  return `${typeOf(id)}.${instanceOf(id)}`;
}

export function idFromString(s: string): ObjectId {
  const m = /^(\d+)\.(\d+)$/.exec(s);
  if (!m) throw new Error(`bad object id ${s}`);
  return objectId(Number(m[1]), Number(m[2]));
}
