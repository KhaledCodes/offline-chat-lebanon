/**
 * MeshProtocol.test.ts - Unit tests for the Jisr BLE mesh packet encoder/decoder.
 */

import {
  encode,
  decode,
  generateMessageId,
  PacketType,
  MeshPacket,
  PROTOCOL_VERSION,
  MAX_TTL,
  BROADCAST_DST,
} from '../MeshProtocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid MeshPacket with sensible defaults. */
function makePacket(overrides: Partial<MeshPacket> = {}): MeshPacket {
  return {
    version: PROTOCOL_VERSION,
    type: PacketType.MESSAGE,
    msgId: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]),
    srcId: new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]),
    dstId: new Uint8Array([0x11, 0x22, 0x33, 0x44]),
    ttl: 5,
    hopCount: 2,
    payload: new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]),
    ...overrides,
  };
}

/** Create a Uint8Array filled with a repeating byte value. */
function filledPayload(length: number, fill = 0x42): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

// ---------------------------------------------------------------------------
// PacketType enum values
// ---------------------------------------------------------------------------

describe('PacketType enum', () => {
  it('HANDSHAKE equals 0x01', () => {
    expect(PacketType.HANDSHAKE).toBe(0x01);
  });

  it('MESSAGE equals 0x02', () => {
    expect(PacketType.MESSAGE).toBe(0x02);
  });

  it('ACK equals 0x03', () => {
    expect(PacketType.ACK).toBe(0x03);
  });

  it('ANNOUNCE equals 0x04', () => {
    expect(PacketType.ANNOUNCE).toBe(0x04);
  });

  it('PEER_EXCHANGE equals 0x05', () => {
    expect(PacketType.PEER_EXCHANGE).toBe(0x05);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Protocol constants', () => {
  it('BROADCAST_DST is [0xFF, 0xFF, 0xFF, 0xFF]', () => {
    expect(BROADCAST_DST).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    expect(BROADCAST_DST.length).toBe(4);
  });

  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('MAX_TTL is 7', () => {
    expect(MAX_TTL).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// encode()
// ---------------------------------------------------------------------------

describe('encode()', () => {
  it('produces output of length 22 + payload.length', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const pkt = makePacket({ payload });
    const encoded = encode(pkt);
    expect(encoded.length).toBe(22 + payload.length);
  });

  it('produces 22 bytes for an empty payload', () => {
    const pkt = makePacket({ payload: new Uint8Array(0) });
    const encoded = encode(pkt);
    expect(encoded.length).toBe(22);
  });

  it('writes version at byte 0', () => {
    const pkt = makePacket();
    const encoded = encode(pkt);
    expect(encoded[0]).toBe(PROTOCOL_VERSION);
  });

  it('writes packet type at byte 1', () => {
    const pkt = makePacket({ type: PacketType.ACK });
    const encoded = encode(pkt);
    expect(encoded[1]).toBe(PacketType.ACK);
  });

  it('writes msgId at bytes 2..9', () => {
    const msgId = new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80]);
    const pkt = makePacket({ msgId });
    const encoded = encode(pkt);
    expect(encoded.slice(2, 10)).toEqual(msgId);
  });

  it('writes srcId at bytes 10..13', () => {
    const srcId = new Uint8Array([0xA1, 0xB2, 0xC3, 0xD4]);
    const pkt = makePacket({ srcId });
    const encoded = encode(pkt);
    expect(encoded.slice(10, 14)).toEqual(srcId);
  });

  it('writes dstId at bytes 14..17', () => {
    const dstId = new Uint8Array([0xE5, 0xF6, 0x07, 0x18]);
    const pkt = makePacket({ dstId });
    const encoded = encode(pkt);
    expect(encoded.slice(14, 18)).toEqual(dstId);
  });

  it('writes ttl at byte 18', () => {
    const pkt = makePacket({ ttl: 3 });
    const encoded = encode(pkt);
    expect(encoded[18]).toBe(3);
  });

  it('writes hopCount at byte 19', () => {
    const pkt = makePacket({ hopCount: 4 });
    const encoded = encode(pkt);
    expect(encoded[19]).toBe(4);
  });

  it('writes payload length as uint16 LE at bytes 20..21', () => {
    const payload = filledPayload(300);
    const pkt = makePacket({ payload });
    const encoded = encode(pkt);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    expect(view.getUint16(20, true)).toBe(300);
  });

  it('writes payload data starting at byte 22', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const pkt = makePacket({ payload });
    const encoded = encode(pkt);
    expect(encoded.slice(22)).toEqual(payload);
  });

  // --- Validation errors ---

  it('rejects msgId not 8 bytes (too short)', () => {
    const pkt = makePacket({ msgId: new Uint8Array(7) });
    expect(() => encode(pkt)).toThrow(RangeError);
    expect(() => encode(pkt)).toThrow(/msgId must be 8 bytes/);
  });

  it('rejects msgId not 8 bytes (too long)', () => {
    const pkt = makePacket({ msgId: new Uint8Array(9) });
    expect(() => encode(pkt)).toThrow(RangeError);
  });

  it('rejects srcId not 4 bytes (too short)', () => {
    const pkt = makePacket({ srcId: new Uint8Array(3) });
    expect(() => encode(pkt)).toThrow(RangeError);
    expect(() => encode(pkt)).toThrow(/srcId must be 4 bytes/);
  });

  it('rejects srcId not 4 bytes (too long)', () => {
    const pkt = makePacket({ srcId: new Uint8Array(5) });
    expect(() => encode(pkt)).toThrow(RangeError);
  });

  it('rejects dstId not 4 bytes (too short)', () => {
    const pkt = makePacket({ dstId: new Uint8Array(2) });
    expect(() => encode(pkt)).toThrow(RangeError);
    expect(() => encode(pkt)).toThrow(/dstId must be 4 bytes/);
  });

  it('rejects dstId not 4 bytes (too long)', () => {
    const pkt = makePacket({ dstId: new Uint8Array(6) });
    expect(() => encode(pkt)).toThrow(RangeError);
  });

  it('rejects TTL > MAX_TTL (7)', () => {
    const pkt = makePacket({ ttl: 8 });
    expect(() => encode(pkt)).toThrow(RangeError);
    expect(() => encode(pkt)).toThrow(/ttl must be 0\.\.7/);
  });

  it('rejects negative TTL', () => {
    const pkt = makePacket({ ttl: -1 });
    expect(() => encode(pkt)).toThrow(RangeError);
  });

  it('rejects payload > MAX_PAYLOAD_SIZE (490)', () => {
    const pkt = makePacket({ payload: filledPayload(491) });
    expect(() => encode(pkt)).toThrow(RangeError);
    expect(() => encode(pkt)).toThrow(/payload too large/);
  });

  it('accepts payload of exactly 490 bytes (MAX_PAYLOAD_SIZE)', () => {
    const pkt = makePacket({ payload: filledPayload(490) });
    expect(() => encode(pkt)).not.toThrow();
    const encoded = encode(pkt);
    expect(encoded.length).toBe(22 + 490);
  });

  it('accepts TTL of exactly 7 (MAX_TTL)', () => {
    const pkt = makePacket({ ttl: 7 });
    expect(() => encode(pkt)).not.toThrow();
  });

  it('accepts TTL of 0', () => {
    const pkt = makePacket({ ttl: 0 });
    expect(() => encode(pkt)).not.toThrow();
    const encoded = encode(pkt);
    expect(encoded[18]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// decode()
// ---------------------------------------------------------------------------

describe('decode()', () => {
  it('decodes an encoded packet and all fields match the original', () => {
    const original = makePacket();
    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.version).toBe(original.version);
    expect(decoded.type).toBe(original.type);
    expect(decoded.msgId).toEqual(original.msgId);
    expect(decoded.srcId).toEqual(original.srcId);
    expect(decoded.dstId).toEqual(original.dstId);
    expect(decoded.ttl).toBe(original.ttl);
    expect(decoded.hopCount).toBe(original.hopCount);
    expect(decoded.payload).toEqual(original.payload);
  });

  it('rejects packets shorter than 22 bytes', () => {
    expect(() => decode(new Uint8Array(0))).toThrow(RangeError);
    expect(() => decode(new Uint8Array(1))).toThrow(RangeError);
    expect(() => decode(new Uint8Array(21))).toThrow(RangeError);
    expect(() => decode(new Uint8Array(21))).toThrow(/Packet too short/);
  });

  it('accepts a packet of exactly 22 bytes (zero payload)', () => {
    const pkt = makePacket({ payload: new Uint8Array(0) });
    const encoded = encode(pkt);
    expect(encoded.length).toBe(22);
    const decoded = decode(encoded);
    expect(decoded.payload.length).toBe(0);
  });

  it('rejects unsupported protocol version', () => {
    const pkt = makePacket();
    const encoded = encode(pkt);
    // Overwrite version byte to 99
    encoded[0] = 99;
    expect(() => decode(encoded)).toThrow(/Unsupported protocol version/);
  });

  it('rejects unknown packet types', () => {
    const pkt = makePacket();
    const encoded = encode(pkt);
    // Overwrite type byte to 0xFE (not a valid type)
    encoded[1] = 0xfe;
    expect(() => decode(encoded)).toThrow(/Unknown packet type/);
  });

  it('rejects packet type 0x00', () => {
    const pkt = makePacket();
    const encoded = encode(pkt);
    encoded[1] = 0x00;
    expect(() => decode(encoded)).toThrow(/Unknown packet type/);
  });

  it('rejects TTL > MAX_TTL (7)', () => {
    const pkt = makePacket({ ttl: 5 });
    const encoded = encode(pkt);
    // Overwrite TTL byte to 8
    encoded[18] = 8;
    expect(() => decode(encoded)).toThrow(RangeError);
    expect(() => {
      const buf = encode(makePacket({ ttl: 5 }));
      buf[18] = 8;
      decode(buf);
    }).toThrow(/TTL out of range/);
  });

  it('rejects TTL of 255', () => {
    const pkt = makePacket({ ttl: 5 });
    const encoded = encode(pkt);
    encoded[18] = 255;
    expect(() => decode(encoded)).toThrow(RangeError);
  });

  it('rejects payload length mismatch (header says more bytes than available)', () => {
    const pkt = makePacket({ payload: new Uint8Array([1, 2, 3]) });
    const encoded = encode(pkt);
    // Encoded is 25 bytes (22 + 3). Overwrite payload length to claim 100 bytes.
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    view.setUint16(20, 100, true);
    expect(() => decode(encoded)).toThrow(RangeError);
    expect(() => decode(encoded)).toThrow(/Payload length mismatch/);
  });

  it('handles extra trailing bytes gracefully (ignores them)', () => {
    const pkt = makePacket({ payload: new Uint8Array([0xAA, 0xBB]) });
    const encoded = encode(pkt);
    // Append extra bytes after the packet
    const padded = new Uint8Array(encoded.length + 10);
    padded.set(encoded, 0);
    padded.fill(0xFF, encoded.length);
    const decoded = decode(padded);
    // Payload should still be the original 2 bytes
    expect(decoded.payload).toEqual(new Uint8Array([0xAA, 0xBB]));
  });
});

// ---------------------------------------------------------------------------
// encode/decode roundtrip
// ---------------------------------------------------------------------------

describe('encode/decode roundtrip', () => {
  it.each([0, 1, 100, 490])(
    'roundtrips correctly with payload size %i bytes',
    (size) => {
      const payload = filledPayload(size, 0xAB);
      const original = makePacket({ payload });
      const decoded = decode(encode(original));

      expect(decoded.version).toBe(original.version);
      expect(decoded.type).toBe(original.type);
      expect(decoded.msgId).toEqual(original.msgId);
      expect(decoded.srcId).toEqual(original.srcId);
      expect(decoded.dstId).toEqual(original.dstId);
      expect(decoded.ttl).toBe(original.ttl);
      expect(decoded.hopCount).toBe(original.hopCount);
      expect(decoded.payload).toEqual(original.payload);
      expect(decoded.payload.length).toBe(size);
    },
  );

  it('roundtrips all PacketType values', () => {
    const types = [
      PacketType.HANDSHAKE,
      PacketType.MESSAGE,
      PacketType.ACK,
      PacketType.ANNOUNCE,
      PacketType.PEER_EXCHANGE,
    ];

    for (const type of types) {
      const original = makePacket({ type });
      const decoded = decode(encode(original));
      expect(decoded.type).toBe(type);
    }
  });

  it('roundtrips broadcast destination', () => {
    const original = makePacket({ dstId: new Uint8Array(BROADCAST_DST) });
    const decoded = decode(encode(original));
    expect(decoded.dstId).toEqual(BROADCAST_DST);
  });

  it('roundtrips TTL boundary values (0 and 7)', () => {
    for (const ttl of [0, 7]) {
      const original = makePacket({ ttl });
      const decoded = decode(encode(original));
      expect(decoded.ttl).toBe(ttl);
    }
  });

  it('roundtrips hopCount of 0 and 255', () => {
    for (const hopCount of [0, 255]) {
      const original = makePacket({ hopCount });
      const decoded = decode(encode(original));
      expect(decoded.hopCount).toBe(hopCount);
    }
  });
});

// ---------------------------------------------------------------------------
// generateMessageId()
// ---------------------------------------------------------------------------

describe('generateMessageId()', () => {
  it('returns a Uint8Array of 8 bytes', () => {
    const id = generateMessageId();
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(8);
  });

  it('produces unique IDs (100 IDs, all different)', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = generateMessageId();
      const hex = Array.from(id)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      ids.add(hex);
    }
    expect(ids.size).toBe(100);
  });

  it('first 4 bytes contain a plausible timestamp (within 10 seconds of now)', () => {
    const id = generateMessageId();
    const view = new DataView(id.buffer, id.byteOffset, id.byteLength);
    const timestampSec = view.getUint32(0, false); // big-endian per implementation
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Math.abs(timestampSec - nowSec)).toBeLessThanOrEqual(10);
  });

  it('can be used as a valid msgId for encode/decode', () => {
    const pkt = makePacket({ msgId: generateMessageId() });
    expect(() => encode(pkt)).not.toThrow();
    const decoded = decode(encode(pkt));
    expect(decoded.msgId).toEqual(pkt.msgId);
  });
});
