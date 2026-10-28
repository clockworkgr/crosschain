# 1. The codec

Everything in this chain that is hashed, signed, stored, or sent to a peer first becomes bytes through `src/codec/writer.ts`, and comes back through `src/codec/reader.ts`. The two files are the floor the rest of the node stands on: [the crypto layer](02-crypto.md) hashes and signs the bytes the writer produces, [the chain types](03-types.md) define one `encode`/`decode` pair per object on top of these primitives, the p2p messages ([chapter 6](06-p2p.md)), the block store ([chapter 10](10-store.md)), the object database ([chapter 9](09-database.md)) and the proofs carried over RPC ([chapter 12](12-rpc.md)) all go through the same two classes. Nothing feeds the codec; it depends only on the JavaScript standard library.

## Concepts

### Serialization and canonical encoding

A program holds a block as an object graph in memory. To hash it, sign it, or send it, the object must be turned into a sequence of bytes: that is serialization. Most serialization formats allow many byte sequences for the same value. JSON is the obvious example: `{"a":1,"b":2}` and `{"b":2,"a":1}` and `{ "a" : 1.0, "b" : 2 }` are the same object, and JSON cannot represent a 64-bit integer at all without losing precision or turning it into a string.

A blockchain cannot live with that. A block hash is a hash of bytes, not of an object. If two nodes serialize the same block differently, they compute different hashes, disagree about which block was voted on, and the chain stops. The same goes for signatures: a validator signs bytes, and every other node must reproduce exactly those bytes to check the signature. So the encoding must be *canonical*: for every value there is exactly one byte sequence, and every node produces it. The header comment of `src/codec/writer.ts` states the rule and the reason:

```ts
/**
 * Binary encoding primitives.
 *
 * Everything that is hashed, signed, or sent over the wire goes through this
 * writer, so every object has exactly one byte representation. JSON is
 * deliberately not used for anything consensus-critical: key order, number
 * formatting and BigInt all make it non-canonical.
```

`DESIGN.md` section 4 records the decision: "hand-written binary encode/decode per message and per state object, Graphene raw-serializer style. Deterministic by construction. JSON is not used for anything that gets hashed or signed." Graphene is the BitShares codebase; its `fc::raw` serializer writes each field of a struct in declaration order with no tags, no field names and no padding. Cosmos SDK and Tendermint went a different way, protobuf with canonical rules layered on top, and earlier a custom codec called Amino; the end goal is the same, one byte string per value.

Canonical encoding is only half the story. The *decoder* must also accept exactly one byte string per value. If a decoder tolerated a trailing byte, or accepted the value `2` as `true`, then two different byte strings would decode to the same object. That object would then have two hashes, and anything keyed by hash, such as the mempool's duplicate detection or the transaction index, could be fooled. So the reader is strict: it rejects trailing bytes, rejects a `bool` that is not 0 or 1, rejects an `option` flag that is not 0 or 1, and rejects strings that are not valid UTF-8.

### The layout rules

The writer's header comment is the whole wire format:

```ts
 * Layout rules (big-endian everywhere):
 *   u8          1 byte
 *   u16         2 bytes
 *   u32         4 bytes
 *   u64 / i64   8 bytes (BigInt; i64 is two's complement)
 *   bool        1 byte, 0 or 1
 *   fixed(n)    raw bytes, no prefix (both sides know the length)
 *   bytes       u32 length prefix + raw bytes
 *   string      u32 length prefix + utf-8 bytes
 *   option(x)   u8 flag (0 absent, 1 present) then x
 *   array(xs)   u32 count then the elements
```

Three things to notice.

*Big-endian* means the most significant byte comes first. Besides being the conventional network byte order, it has a property the object database depends on: a big-endian unsigned integer sorts the same way as a byte string. `DESIGN.md` section 6 builds index keys from "big-endian integers, strings with a zero terminator, compound keys by concatenation", so that a range scan over bytes is a range scan over numbers.

*Fixed versus length-prefixed.* A hash is always 32 bytes and an ML-DSA-44 signature always 2420 bytes, so there is no point spending 4 bytes saying so; `fixed` writes the raw bytes and the reader is told how many to take. Transactions and strings vary in length and get a `u32` prefix. Which one a field uses is part of the schema: the reader of `fixed` must know the length from context.

*There is no schema language.* The order of fields is the schema, written twice, once in each `encode` function and once in each `decode` function. That is the Graphene approach. It is simple and fast, and the cost is that adding a field to a header changes every header hash. `RPC-SYNC-PROOFS.md` section 2.1 is the record of exactly that happening: two fields were added to the header, and a protocol `version` field was added at the same time so that a node can reject headers from the other layout.

### Integers and BigInt

JavaScript numbers are IEEE doubles, exact only up to 2^53. Heights, amounts and voting power can exceed that, and `DESIGN.md` section 4 rules that they "are BigInt. Plain numbers are doubles and must never carry consensus-critical values. No floats in state." The codec enforces this at the type level: `u64` and `i64` take and return `bigint`, while `u8`, `u16` and `u32` use `number`, which is exact in that range.

### Decoding hostile input

The writer only ever sees data the node built itself, so its errors are programmer errors and it throws plain `RangeError`s. The reader sees bytes from peers, and a peer may be malicious. The header comment of `src/codec/reader.ts` sets the goal: "Every read is bounds-checked so a malicious peer cannot make us allocate or read past the buffer." The two attacks it guards against are reading past the end of the buffer (a crash, or in a less safe language a memory disclosure) and a length prefix that says "one billion elements follow" and makes the decoder allocate a billion-element array before it notices there are only four bytes left. Every read checks the remaining byte count, every variable-length read takes a maximum, and `array` additionally refuses a count larger than the remaining bytes, since every element needs at least one byte. The `REVIEW-2026-10-28.md` summary names "strict binary decoding" as one of the strongest parts of the codebase.

## The code, file by file

### src/codec/writer.ts

The writer owns a growable byte buffer and appends to it. It exports one class and one helper.

**`class Writer`.** Private state is `buf: Uint8Array`, a `DataView` over it, and `len`, the number of bytes written so far. The constructor takes an `initialCapacity` (default 256) and the private `ensure(n)` doubles the buffer until `n` more bytes fit:

```ts
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
```

The `DataView` is rebuilt whenever the buffer is replaced, because a view is bound to one `ArrayBuffer`. Doubling keeps the amortized cost of appending constant.

Every write method returns `this`, so encoders can be written as chains. `src/types/txproof.ts` does exactly that: `w.u64(p.height).u32(p.index).bytes(p.tx).u32(p.count).array(p.siblings, (w, s) => w.fixed(s))`.

**`u8(v)`, `u16(v)`, `u32(v)`.** Each checks that `v` is an integer in range and throws `RangeError` otherwise, then writes big-endian through the view (`setUint16`, `setUint32` default to big-endian when the little-endian flag is omitted). `u8` writes directly into the array:

```ts
  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError(`u8 out of range: ${v}`);
    this.ensure(1);
    this.buf[this.len++] = v;
    return this;
  }
```

The `Number.isInteger` check matters: `w.u8(1.5)` would otherwise be silently truncated by the typed array, and two nodes that computed `1.5` and `1.4` would encode the same byte.

**`bool(v)`** is `u8(v ? 1 : 0)`.

**`u64(v: bigint)`** and **`i64(v: bigint)`** check the range (`0` to `2^64 - 1`, and `-2^63` to `2^63 - 1`) and write with `setBigUint64` and `setBigInt64`. `i64` is two's complement, which is what `setBigInt64` produces. The only `i64` fields in the chain are proposer priorities, which go negative, and a proposal's `polRound`, which is `-1` when there is no proof-of-lock round.

**`fixed(b)`** copies the bytes with no prefix. It does not check the length: `encodeHeader` writes `w.fixed(h.lastBlockHash)` trusting that the hash is 32 bytes. If a bug ever produced a 31-byte hash, the writer would emit it without complaint, and the error would surface only on the other side, where `decodeHeader` reads `fixed(HASH_SIZE)` and every later field comes out shifted by one byte until `finish()` or a `need` check fails. The writer's contract is that its callers pass values of the right type and size; the decoder is the one that enforces sizes, because it is the one facing untrusted input. **`bytes(b)`** writes `u32(b.length)` then the bytes. **`string(s)`** first refuses a string holding a lone surrogate, then encodes with `TextEncoder` (always UTF-8) and writes it as `bytes`:

```ts
  string(s: string): this {
    // A lone surrogate would be written as U+FFFD, so two different strings would share an encoding.
    if (/\p{Surrogate}/u.test(s)) throw new RangeError('string is not well-formed UTF-16');
    return this.bytes(new TextEncoder().encode(s));
  }
```

A JavaScript string is a sequence of UTF-16 code units, and nothing stops a program from building one with an unpaired surrogate half. `TextEncoder` cannot represent that in UTF-8 and silently writes U+FFFD instead, so two different strings would share one encoding, and the bytes would decode to a string the caller never wrote. The writer is the one place that can catch it, so it does: the `RangeError` is a bug in the caller, not a transaction's fault. Note that `new TextEncoder()` is constructed on every call; that is a small cost the code accepts for simplicity.

**`option(v, f)`** writes a one-byte flag and, if present, calls back to encode the value:

```ts
  option<T>(v: T | null, f: (w: Writer, v: T) => void): this {
    if (v === null) return this.u8(0);
    this.u8(1);
    f(this, v);
    return this;
  }
```

Only `null` is "absent"; `undefined` is not handled, so a field typed `T | null` must really hold `null`. The chain types follow that rule (`blockHash: Uint8Array | null` in a vote, `lastCommit: Commit | null` in a block).

**`array(xs, f)`** writes `u32(xs.length)` then each element through `f`. The element encoder gets the writer as its first argument, which is why so many encoders in `src/types/` have the signature `(w: Writer, x: T) => void` and can be passed straight in, as in `w.array(b.evidence, encodeEvidence)`.

**`finish()`** returns `this.buf.slice(0, this.len)`, a copy. The writer can keep being used afterwards, but nobody does that.

**`encode(f)`** is the convenience wrapper used everywhere:

```ts
/** Convenience: run an encoding function and return the bytes. */
export function encode(f: (w: Writer) => void): Uint8Array {
  const w = new Writer();
  f(w);
  return w.finish();
}
```

`headerHash` in `src/types/block.ts` is `sha256(encode((w) => encodeHeader(w, h)))`: build a writer, run the encoder, hash the result. That three-step shape repeats for every hash in the chain.

### The encode/decode pair convention

Every type in `src/types/` and every message in `src/p2p/messages.ts` follows one convention built on these two classes: an `encodeX(w: Writer, x: X): void` that writes fields in a fixed order, and a `decodeX(r: Reader): X` that reads them in the same order and validates what it can. Neither allocates a buffer; they are composable pieces, which is what lets `encodeBlock` call `encodeHeader`, `encodeCommit` and `encodeEvidence`, and `decodeBlock` call their counterparts. Only at the top does a caller wrap them: `encode((w) => encodeBlock(w, b))` to get bytes, `decode(buf, decodeBlock)` to get a block and insist nothing is left over. Where a type needs a hash, a third function (`headerHash`, `commitHash`, `evidenceHash`) hashes the `encode` output; where it needs sign bytes, a fourth (`voteSignBytes`, `proposalSignBytes`) encodes a different, smaller field list. Keeping the field order in exactly two places per type, side by side, is the whole discipline.

Failure modes: every writer method throws on out-of-range input, and nothing catches those errors. Review finding 7 in `REVIEW-2026-10-28.md` shows why that is dangerous when the input comes from state rather than from a peer: a staking share value overflowed `u64` *after* the block had been decided, so `root()` threw and execution halted. The fix was to bound the value at admission, not to soften the codec.

### src/codec/reader.ts

The reader walks a buffer from a position and refuses to go past the end. It exports an error class, the reader, and a helper.

**`class CodecError extends Error`.** Every decoding failure caused by the input is a `CodecError` with `name = 'CodecError'`, so a log line or a test can tell a structural failure from anything else. Nothing in `src/` dispatches on the class today: the network's frame handler in `src/p2p/network.ts` wraps `decodeMessage` in a `try/catch`, treats any error as a malformed message, logs it as `'undecodable message'` with the error text and scores the peer 20 points. That is the right policy, because the type-level decoders in `src/types/` throw plain `Error`s for semantic problems ("bad vote type", "validator set out of order"), and both kinds of failure mean the same thing about the peer.

**`class Reader`.** The constructor takes the buffer and an optional starting position:

```ts
  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = pos;
  }
```

The `DataView` is built with the array's `byteOffset` and `byteLength`. That is essential: a `Uint8Array` can be a window into a larger `ArrayBuffer` (a Node `Buffer` from a socket almost always is), and a view over `buf.buffer` alone would read the wrong bytes. The writer does not need this because its buffer always starts at offset 0.

**`remaining()`** is `buf.length - pos`. The private **`need(n)`** throws `CodecError('need N bytes, have M')` when fewer than `n` remain. Every read calls it first.

**`u8()`**, **`u16()`**, **`u32()`**, **`u64()`**, **`i64()`** mirror the writer, reading through the view and advancing `pos`. **`bool()`** is stricter than "non-zero is true":

```ts
  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new CodecError(`bad bool ${v}`);
    return v === 1;
  }
```

This is the canonical-decoding rule from the Concepts section: `0x02` is not a second way to spell `true`.

**`fixed(n)`** reads exactly `n` bytes and returns `this.buf.slice(...)`, a copy:

```ts
  fixed(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
```

A copy rather than a `subarray` means decoded objects never alias the buffer they were decoded from. The TCP transport (`src/p2p/tcp.ts`) already copies each frame out of its receive buffer before delivering it, so today this is a second copy; it is what makes the reader safe to use on a buffer the caller intends to reuse, such as an LMDB value, without the caller having to know. The cost is an allocation per field.

**`bytes(maxLen = 64 MiB)`** reads a `u32` count, rejects it if above `maxLen`, then reads that many bytes with `fixed`. The default limit is generous; callers that know better pass a tighter one. **`string(maxLen = 1 MiB)`** decodes the bytes as UTF-8:

```ts
  string(maxLen = 1024 * 1024): string {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.bytes(maxLen));
  }
```

Both options matter. `fatal: true` makes invalid UTF-8 a thrown `TypeError` rather than a silent replacement character, so a peer cannot send bytes that decode to a string the writer could never have produced. `ignoreBOM: true` stops `TextDecoder` from doing what it does by default, which is to strip a leading byte order mark (U+FEFF): without it, a string beginning with that character decoded to a different string than was encoded, and the codec was not a bijection on such strings (review finding 41 in `REVIEW-2026-10-28.md`). No chain string starts with one, but "decode is the exact inverse of encode" is the kind of rule that should hold without exceptions.

**`option(f)`** reads the flag and insists it is 0 or 1:

```ts
  option<T>(f: (r: Reader) => T): T | null {
    const flag = this.u8();
    if (flag === 0) return null;
    if (flag !== 1) throw new CodecError(`bad option flag ${flag}`);
    return f(this);
  }
```

**`array(f, maxCount = 1_000_000)`** is where the allocation guard lives:

```ts
  array<T>(f: (r: Reader) => T, maxCount = 1_000_000): T[] {
    const n = this.u32();
    if (n > maxCount) throw new CodecError(`array too long: ${n} > ${maxCount}`);
    // Each element needs at least one byte, which bounds allocation by input size.
    if (n > this.remaining()) throw new CodecError(`array count ${n} exceeds remaining bytes`);
    const out: T[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(this);
    return out;
  }
```

Two checks, for two reasons. `maxCount` is the semantic limit a caller chooses: `ValidatorSet.decode` passes `10_000`, `decodeBlock` passes `1000` for evidence, `decodeTxProof` passes `64` for siblings. The second check is the structural one: even under the semantic limit, a count larger than the remaining bytes cannot be honest, so the `new Array(n)` allocation is bounded by the size of the input the peer actually sent. The comment states the invariant that makes this sound: every element type in this codebase consumes at least one byte (an absent `option` is one flag byte; an empty `bytes` is a four-byte prefix).

**`finish()`** throws `CodecError('N trailing bytes')` unless the whole buffer was consumed. **`decode(buf, f)`** runs a decoder and then `finish()`:

```ts
/** Convenience: decode a whole buffer and insist nothing is left over. */
export function decode<T>(buf: Uint8Array, f: (r: Reader) => T): T {
  const r = new Reader(buf);
  const v = f(r);
  r.finish();
  return v;
}
```

Every top-level decode in the node uses this helper, so the trailing-bytes rule is enforced wherever a whole message or stored record is decoded. Tagged unions are decoded inside the callback: `decodeMessage` in `src/p2p/messages.ts` reads one `r.u8()`, looks the code up in a table, throws `'unknown message type'` if it is not there, and switches on the name to decode the rest. There is no separate "peek at the type" step.

What is deliberately absent: there is no `peek`, no `skip`, no way to rewind, and no streaming. A message is decoded in one pass from one buffer. The limits on `bytes`, `string` and `array` are the only tunables.

### The limits in use

The defaults on `bytes`, `string` and `array` are the outer fence. The real fences are the arguments the type decoders pass, and the frame and block limits above the codec. The explicit ones in the chain types and the wire protocol are:

| decoder | field | limit |
|---|---|---|
| `src/types/block.ts` `decodeHeader` | `chainId` | `string(256)` |
| `src/types/block.ts` `decodeCommit` | `signatures` | `array(..., 10_000)` |
| `src/types/block.ts` `decodeBlock` | `evidence` | `array(decodeEvidence, 1000)` |
| `src/types/block.ts` `decodeBlock` | each transaction | `bytes()` (64 MiB default) |
| `src/types/validator.ts` `decode` | validators | `array(..., 10_000)` |
| `src/types/txproof.ts` `decodeTxProof`, `decodeResultProof` | `siblings` | `array(..., 64)` |
| `src/types/state.ts` `decodeState` | `chainId` | `string(256)` |
| `src/p2p/messages.ts` hello fields | chain id, address, user agent | `string(256)` |
| `src/p2p/messages.ts` | address list | `array(string(256), 256)` |
| `src/p2p/messages.ts` | inventory hashes | `array(fixed(32), 10_000)` |
| `src/p2p/messages.ts` | blocks in a sync response | `array(..., 64)` |

Two things bound what these can add up to. A TCP frame is refused above `MAX_FRAME = 32 * 1024 * 1024` in `src/p2p/tcp.ts` before any decoding starts, and a block is rejected above `maxBlockBytes` (default 4 MiB, `DEFAULT_LIMITS` in `src/consensus/consensus.ts`) by validation after decoding. So a transaction's 64 MiB `bytes()` default is never the binding limit; the frame is. The database proofs in `src/db/proof.ts` and the snapshot chunks in `src/app/core/snapshot.ts` carry their own, tighter numbers (sibling lists of 16, 64, 128 or 256; keys of at most 4,096 bytes).

### A worked example: the bytes of a vote

To make the rules concrete, here are the exact bytes of a few encodings, produced by running the writer. `voteSignBytes` from [chapter 3](03-types.md) writes a chain id string, the vote type as `u8`, the height as `u64`, the round as `u32` and an optional block hash. For a nil prevote at height 7, round 1, on a chain named `demo`:

```
00000004 64656d6f   string: u32 length 4, then "demo"
01                  u8: VoteType.Prevote
0000000000000007    u64: height 7
00000001            u32: round 1
00                  option flag 0: nil (no block hash)
```

Twenty-two bytes. The same vote for a block whose hash is thirty-two `0xab` bytes is fifty-four: the flag becomes `01` and the thirty-two hash bytes follow with no length prefix, because `fixed` is used for a value whose size both sides know.

Other primitives from the unit test, as the writer emits them:

```
string "héllo"   00000006 68c3a96c6c6f      length counts UTF-8 bytes (6), not characters (5)
i64 -5           fffffffffffffffb           two's complement, big-endian
option null      00
option 7 (u8)    01 07
array [1n, 2n]   00000002 0000000000000001 0000000000000002
```

The `héllo` line is worth a second look: the length prefix is six because `é` is two bytes in UTF-8. A decoder that counted characters would read one byte short.

## How it is tested

`test/units.test.ts`, `describe('codec')`, has three cases.

**`round-trips every primitive`** encodes one value of every kind in a single chain (`u8(255)`, `bool(true)`, `u32(0xdeadbeef)`, `u64(2n ** 64n - 1n)`, `i64(-5n)`, `bytes`, a non-ASCII `string('héllo')`, an absent and a present `option`, an `array` of `u64`) and decodes them in the same order, asserting deep equality. It proves the writer and reader agree on every primitive, including the extremes of `u64` and a negative `i64`, and that UTF-8 survives.

**`rejects truncated input, trailing bytes, and hostile lengths`** proves the four guards:

```ts
    expect(() => decode(new Uint8Array([0, 0]), (r) => r.u32())).toThrow(CodecError);
    expect(() => decode(new Uint8Array([1, 2]), (r) => r.u8())).toThrow(/trailing/);
    expect(() => decode(new Uint8Array([0xff, 0xff, 0xff, 0xff]), (r) => r.bytes())).toThrow(CodecError);
    expect(() => decode(new Uint8Array([0xff, 0xff, 0xff, 0xff]), (r) => r.array((r) => r.u8()))).toThrow(CodecError);
```

Two bytes where four are needed; one byte left over; a `bytes` length of 4,294,967,295 with nothing behind it; the same as an array count. The last two are the allocation attacks from the Concepts section, and both are refused before anything is allocated.

**`round-trips p2p messages`** encodes and decodes five message shapes from `src/p2p/messages.ts`, which proves the primitives compose into real messages with strings, arrays of strings, `bigint` heights and arrays of hashes.

`test/review.test.ts`, **`decodes a string to exactly what was encoded, byte-order mark included, and refuses malformed UTF-8`**, is the regression for finding 41. It encodes `'﻿name'`, decodes it and asserts strict equality, then encodes the two bytes `0xff 0xfe` with `bytes` and asserts that reading them back as a `string` throws. The second half is the `fatal: true` guarantee: those bytes are not UTF-8, and the decoder says so instead of inventing characters. The same file's **`encodes only well-formed strings`** is the writer's side: `w.string('\uD800')`, a lone high surrogate, throws `/well-formed/`, while a string with a real astral character (`'ok \u{1F600}'`, a surrogate pair) round-trips unchanged.

Beyond that, the codec is exercised indirectly by every other suite, because every block, vote, validator set, state record and proof goes through it. One test uses it to build *malformed* input on purpose: `test/review.test.ts`, `rejects decoded validator sets with duplicate members, wrong order or a bad proposer index`, hand-encodes validator sets with `encode((w) => w.array(...).i64(...))` to feed `ValidatorSet.decode` a duplicate member, a reversed order and an out-of-range proposer index. That is the pattern to copy when writing a test for any decoder: `encode` lets you write bytes the honest encoder would never produce.

`bench/codec.bench.ts` measures `encodeTransaction`, `decodeTransaction`, `txHash` and `txsRoot` over 500 signed transfers; `README.md` reports that a signed transfer is 2.5 KiB and that 1,668 fit in the default 4 MiB block.

## Limitations and ideas

Known simplifications:

- Lengths are fixed-width `u32`. A varint would save three bytes on most strings and arrays. The chain does implement a protobuf varint in `src/db/merkle.ts` for ICS23 leaf hashing, but the codec itself does not use it. With 2420-byte signatures dominating every message, the saving would be invisible.
- There is no schema or versioning. Changing a field order changes every hash and needs a protocol version bump (the header's `version` field exists for this reason, see `RPC-SYNC-PROOFS.md` section 2.1).
- `string` and `bytes` always copy, and `TextEncoder`/`TextDecoder` instances are created per call.
- The reader decodes from a complete buffer; a message larger than memory cannot be streamed. The p2p layer bounds frame sizes instead.
- `Writer.fixed` does not check the length of what it is given; a wrong-sized hash or signature is caught only at decode time.

Exercises:

1. Write a fuzzer: generate random byte strings, feed them to `decodeBlock`, `decodeVote` and `ValidatorSet.decode` from [chapter 3](03-types.md), and assert that every failure is a thrown `Error` (never a hang or an out-of-memory). Try to find an input that allocates more than its own size.
2. Add `varint`/`readVarint` methods to `Writer` and `Reader`, switch `bytes`, `string` and `array` prefixes to them, and run the test suite. Count how many hashes in `test/` change and why.
3. Add a `Reader.peekU8()` and a `Reader.skip(n)`, then write a p2p message filter that drops frames of an unwanted type without decoding them. Decide whether `skip` undermines the "every element needs a byte" guard in `array`.
4. Write a round-trip property test for `string`: random strings of random Unicode code points. Include unpaired surrogates and check that the writer refuses every one of them with a `RangeError`; then remove that check, find out what `TextEncoder` does with a lone surrogate, and watch the round trip fail.
5. Implement a canonical JSON encoder (sorted keys, no whitespace, integers as strings) and compare the size and encode time of a block against the binary codec using `bench/codec.bench.ts` as a template.
6. Replace `fixed`'s `slice` with `subarray`, run the network tests, and reason about whether anything can break. Then make the TCP transport deliver a `subarray` of its receive buffer instead of a copy and see.
7. Add a `Writer.fixedN(n, b)` that throws unless `b.length === n`, use it for every hash, address and signature field in `src/types/`, and write the test that feeds `encodeHeader` a 31-byte hash.

## Where to next

[Chapter 2](02-crypto.md) hashes and signs the bytes the writer produces: SHA-256, ML-DSA-44 keys with domain-separated contexts, and the worker pool that keeps signature verification off the consensus thread.
