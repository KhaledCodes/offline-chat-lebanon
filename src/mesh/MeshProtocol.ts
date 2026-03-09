/**
 * MeshProtocol.ts - Binary packet encoder/decoder for Jisr BLE mesh chat.
 *
 * Packet wire format (22 + N bytes):
 *
 *   Header (20 bytes)
 *   -------------------------------------------------------
 *   Offset  Size  Field       Description
 *   0       1     version     Protocol version (currently 1)
 *   1       1     type        PacketType enum value
 *   2       8     msg_id      Unique message identifier
 *   10      4     src_id      Sender prefix (first 4 bytes of pubkey hash)
 *   14      4     dst_id      Recipient prefix (0xFFFFFFFF = broadcast)
 *   18      1     ttl         Remaining hops (max 7)
 *   19      1     hop_count   Number of hops taken so far
 *
 *   Payload
 *   -------------------------------------------------------
 *   20      2     length      Payload byte count (uint16 little-endian)
 *   22      N     data        Encrypted content
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current protocol version. */
export const PROTOCOL_VERSION = 1;

/** Fixed header size in bytes (before the 2-byte payload length field). */
const HEADER_SIZE = 20;

/** Total overhead = header + 2-byte length field. */
const OVERHEAD_SIZE = HEADER_SIZE + 2; // 22

/** Maximum allowed TTL value. */
export const MAX_TTL = 7;

/** Broadcast destination sentinel (all 0xFF). */
export const BROADCAST_DST = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

/** Maximum payload size (BLE MTU safety -- 512 bytes minus overhead). */
const MAX_PAYLOAD_SIZE = 490;

// ---------------------------------------------------------------------------
// PacketType enum
// ---------------------------------------------------------------------------

export enum PacketType {
  HANDSHAKE     = 0x01,
  MESSAGE       = 0x02,
  ACK           = 0x03,
  ANNOUNCE      = 0x04,
  PEER_EXCHANGE = 0x05,
}

/** Set of valid packet-type values for fast lookup during decode. */
const VALID_PACKET_TYPES = new Set<number>([
  PacketType.HANDSHAKE,
  PacketType.MESSAGE,
  PacketType.ACK,
  PacketType.ANNOUNCE,
  PacketType.PEER_EXCHANGE,
]);

// ---------------------------------------------------------------------------
// MeshPacket interface
// ---------------------------------------------------------------------------

export interface MeshPacket {
  version: number;
  type: PacketType;
  msgId: Uint8Array;     // 8 bytes
  srcId: Uint8Array;     // 4 bytes
  dstId: Uint8Array;     // 4 bytes
  ttl: number;
  hopCount: number;
  payload: Uint8Array;   // variable length
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Serialise a MeshPacket into a compact binary Uint8Array suitable for
 * transmission over a BLE characteristic.
 */
export function encode(packet: MeshPacket): Uint8Array {
  if (packet.msgId.length !== 8) {
    throw new RangeError(`msgId must be 8 bytes, got ${packet.msgId.length}`);
  }
  if (packet.srcId.length !== 4) {
    throw new RangeError(`srcId must be 4 bytes, got ${packet.srcId.length}`);
  }
  if (packet.dstId.length !== 4) {
    throw new RangeError(`dstId must be 4 bytes, got ${packet.dstId.length}`);
  }
  if (packet.ttl < 0 || packet.ttl > MAX_TTL) {
    throw new RangeError(`ttl must be 0..${MAX_TTL}, got ${packet.ttl}`);
  }
  if (packet.hopCount < 0 || packet.hopCount > 255) {
    throw new RangeError(`hopCount must be 0..255, got ${packet.hopCount}`);
  }
  if (packet.payload.length > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `payload too large: ${packet.payload.length} > ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const payloadLen = packet.payload.length;
  const buf = new Uint8Array(OVERHEAD_SIZE + payloadLen);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Header
  buf[0] = packet.version;
  buf[1] = packet.type;
  buf.set(packet.msgId, 2);
  buf.set(packet.srcId, 10);
  buf.set(packet.dstId, 14);
  buf[18] = packet.ttl;
  buf[19] = packet.hopCount;

  // Payload length (uint16 little-endian)
  view.setUint16(20, payloadLen, true);

  // Payload data
  if (payloadLen > 0) {
    buf.set(packet.payload, 22);
  }

  return buf;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Parse a raw byte buffer into a validated MeshPacket.
 *
 * Throws on any structural or value violation so that callers can safely
 * discard malformed frames.
 */
export function decode(data: Uint8Array): MeshPacket {
  if (data.length < OVERHEAD_SIZE) {
    throw new RangeError(
      `Packet too short: need at least ${OVERHEAD_SIZE} bytes, got ${data.length}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // --- version ---
  const version = data[0];
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${version}`);
  }

  // --- type ---
  const type = data[1] as PacketType;
  if (!VALID_PACKET_TYPES.has(type)) {
    throw new Error(`Unknown packet type: 0x${type.toString(16).padStart(2, '0')}`);
  }

  // --- fixed-length fields ---
  const msgId = data.slice(2, 10);
  const srcId = data.slice(10, 14);
  const dstId = data.slice(14, 18);

  const ttl = data[18];
  if (ttl > MAX_TTL) {
    throw new RangeError(`TTL out of range: ${ttl} > ${MAX_TTL}`);
  }

  const hopCount = data[19];

  // --- payload ---
  const payloadLen = view.getUint16(20, true);
  const expectedTotal = OVERHEAD_SIZE + payloadLen;

  if (data.length < expectedTotal) {
    throw new RangeError(
      `Payload length mismatch: header says ${payloadLen} bytes but buffer only has ${data.length - OVERHEAD_SIZE} remaining`,
    );
  }

  if (payloadLen > MAX_PAYLOAD_SIZE) {
    throw new RangeError(
      `Payload length exceeds maximum: ${payloadLen} > ${MAX_PAYLOAD_SIZE}`,
    );
  }

  const payload = data.slice(22, 22 + payloadLen);

  return {
    version,
    type,
    msgId,
    srcId,
    dstId,
    ttl,
    hopCount,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Utility: message ID generator
// ---------------------------------------------------------------------------

/**
 * Generate an 8-byte unique message ID.
 *
 * Layout:
 *   bytes 0..3 : current time in seconds (uint32 big-endian) -- provides
 *                coarse ordering and natural expiry detection.
 *   bytes 4..7 : random nonce -- prevents collisions within the same second.
 */
export function generateMessageId(): Uint8Array {
  const id = new Uint8Array(8);
  const view = new DataView(id.buffer);

  // Timestamp component (seconds since epoch, big-endian for sort order)
  const nowSec = Math.floor(Date.now() / 1000);
  view.setUint32(0, nowSec >>> 0, false);

  // Random component
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(id.subarray(4));
  } else {
    // Fallback for environments without Web Crypto (e.g. older React Native)
    for (let i = 4; i < 8; i++) {
      id[i] = (Math.random() * 256) >>> 0;
    }
  }

  return id;
}
