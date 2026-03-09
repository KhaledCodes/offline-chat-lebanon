/**
 * PeerTable.test.ts - Unit tests for the Jisr peer tracking table.
 */

import { PeerTable, PeerUpdate } from '../PeerTable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a 4-byte ID prefix from an integer. */
function makePrefix(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, n, false);
  return buf;
}

/** Build a PeerUpdate with sensible defaults. */
function makePeerUpdate(overrides: Partial<PeerUpdate> = {}): PeerUpdate {
  return {
    peerId: 'peer-001',
    idPrefix: makePrefix(0xAABBCCDD),
    hopCount: 0,
    directlyConnected: true,
    rssi: -55,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// addOrUpdate
// ---------------------------------------------------------------------------

describe('PeerTable', () => {
  let table: PeerTable;

  beforeEach(() => {
    table = new PeerTable();
  });

  describe('addOrUpdate()', () => {
    it('adds a new peer and increases size', () => {
      expect(table.size).toBe(0);
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1' }));
      expect(table.size).toBe(1);
    });

    it('returns the created PeerInfo with correct fields', () => {
      const update = makePeerUpdate({
        peerId: 'p1',
        idPrefix: makePrefix(0x12345678),
        hopCount: 2,
        directlyConnected: false,
        rssi: -70,
      });

      const info = table.addOrUpdate(update);

      expect(info.peerId).toBe('p1');
      expect(info.idPrefix).toEqual(makePrefix(0x12345678));
      expect(info.hopCount).toBe(2);
      expect(info.directlyConnected).toBe(false);
      expect(info.rssi).toBe(-70);
      expect(info.lastSeen).toBeGreaterThan(0);
    });

    it('updates lastSeen when updating an existing peer', () => {
      const update = makePeerUpdate({ peerId: 'p1' });
      const info1 = table.addOrUpdate(update);
      const firstSeen = info1.lastSeen;

      // Small delay to ensure Date.now() differs
      const info2 = table.addOrUpdate(update);
      expect(info2.lastSeen).toBeGreaterThanOrEqual(firstSeen);
      expect(table.size).toBe(1); // still only one peer
    });

    it('updates rssi on existing peer when provided', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', rssi: -55 }));
      const updated = table.addOrUpdate(makePeerUpdate({ peerId: 'p1', rssi: -80 }));
      expect(updated.rssi).toBe(-80);
    });

    it('keeps existing rssi when new rssi is undefined', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', rssi: -55 }));
      const update: PeerUpdate = {
        peerId: 'p1',
        idPrefix: makePrefix(0xAABBCCDD),
        hopCount: 0,
        directlyConnected: true,
        // rssi not provided
      };
      const updated = table.addOrUpdate(update);
      expect(updated.rssi).toBe(-55);
    });

    it('prefers lower hopCount (route optimization)', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', hopCount: 3, directlyConnected: false }));
      const updated = table.addOrUpdate(
        makePeerUpdate({ peerId: 'p1', hopCount: 1, directlyConnected: false }),
      );
      expect(updated.hopCount).toBe(1);
    });

    it('does not increase hopCount on update', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', hopCount: 1, directlyConnected: false }));
      const updated = table.addOrUpdate(
        makePeerUpdate({ peerId: 'p1', hopCount: 5, directlyConnected: false }),
      );
      // hopCount should stay at 1 since 5 is not less than 1
      expect(updated.hopCount).toBe(1);
    });

    it('sets rssi to null for new peer when not provided', () => {
      const update: PeerUpdate = {
        peerId: 'p1',
        idPrefix: makePrefix(1),
        hopCount: 2,
        directlyConnected: false,
      };
      const info = table.addOrUpdate(update);
      expect(info.rssi).toBeNull();
    });

    it('rejects idPrefix not 4 bytes', () => {
      const update = makePeerUpdate({ idPrefix: new Uint8Array(3) });
      expect(() => table.addOrUpdate(update)).toThrow(RangeError);
    });

    it('adds multiple distinct peers', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: makePrefix(1) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'p2', idPrefix: makePrefix(2) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'p3', idPrefix: makePrefix(3) }));
      expect(table.size).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------

  describe('remove()', () => {
    it('removes an existing peer and returns true', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1' }));
      expect(table.size).toBe(1);
      const removed = table.remove('p1');
      expect(removed).toBe(true);
      expect(table.size).toBe(0);
    });

    it('returns false for a non-existent peer', () => {
      expect(table.remove('nonexistent')).toBe(false);
    });

    it('peer is no longer found by getPeer after removal', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1' }));
      table.remove('p1');
      expect(table.getPeer('p1')).toBeNull();
    });

    it('peer is no longer found by getPeerByIdPrefix after removal', () => {
      const prefix = makePrefix(0x11223344);
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: prefix }));
      table.remove('p1');
      expect(table.getPeerByIdPrefix(prefix)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getDirectPeers
  // -----------------------------------------------------------------------

  describe('getDirectPeers()', () => {
    it('returns only directly connected peers', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'direct1', directlyConnected: true, idPrefix: makePrefix(1) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'relay1', directlyConnected: false, hopCount: 2, idPrefix: makePrefix(2) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'direct2', directlyConnected: true, idPrefix: makePrefix(3) }));

      const direct = table.getDirectPeers();
      const directIds = direct.map((p) => p.peerId).sort();
      expect(directIds).toEqual(['direct1', 'direct2']);
    });

    it('returns empty array when no direct peers exist', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'relay1', directlyConnected: false, hopCount: 2, idPrefix: makePrefix(1) }));
      expect(table.getDirectPeers()).toEqual([]);
    });

    it('returns empty array for empty table', () => {
      expect(table.getDirectPeers()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getReachablePeers
  // -----------------------------------------------------------------------

  describe('getReachablePeers()', () => {
    it('returns all peers (direct and relay)', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'direct1', directlyConnected: true, idPrefix: makePrefix(1) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'relay1', directlyConnected: false, hopCount: 3, idPrefix: makePrefix(2) }));

      const all = table.getReachablePeers();
      expect(all.length).toBe(2);
      const ids = all.map((p) => p.peerId).sort();
      expect(ids).toEqual(['direct1', 'relay1']);
    });

    it('returns empty array for empty table', () => {
      expect(table.getReachablePeers()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getPeerByIdPrefix
  // -----------------------------------------------------------------------

  describe('getPeerByIdPrefix()', () => {
    it('finds the correct peer by 4-byte prefix', () => {
      const prefix = makePrefix(0xDEADBEEF);
      table.addOrUpdate(makePeerUpdate({ peerId: 'target', idPrefix: prefix }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'other', idPrefix: makePrefix(0x12345678) }));

      const found = table.getPeerByIdPrefix(prefix);
      expect(found).not.toBeNull();
      expect(found!.peerId).toBe('target');
    });

    it('returns null when no peer matches', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: makePrefix(1) }));
      expect(table.getPeerByIdPrefix(makePrefix(999))).toBeNull();
    });

    it('returns null for empty table', () => {
      expect(table.getPeerByIdPrefix(makePrefix(1))).toBeNull();
    });

    it('rejects prefix not 4 bytes', () => {
      expect(() => table.getPeerByIdPrefix(new Uint8Array(3))).toThrow(RangeError);
      expect(() => table.getPeerByIdPrefix(new Uint8Array(5))).toThrow(RangeError);
    });

    it('prefers directly connected peer when multiple peers share a prefix', () => {
      const prefix = makePrefix(0xAAAAAAAA);
      // Add a relay peer first
      table.addOrUpdate(makePeerUpdate({
        peerId: 'relay',
        idPrefix: prefix,
        hopCount: 3,
        directlyConnected: false,
      }));
      // Add a direct peer with the same prefix
      table.addOrUpdate(makePeerUpdate({
        peerId: 'direct',
        idPrefix: prefix,
        hopCount: 0,
        directlyConnected: true,
      }));

      const found = table.getPeerByIdPrefix(prefix);
      expect(found).not.toBeNull();
      expect(found!.peerId).toBe('direct');
    });
  });

  // -----------------------------------------------------------------------
  // pruneStale
  // -----------------------------------------------------------------------

  describe('pruneStale()', () => {
    it('removes old peers but keeps fresh ones', () => {
      // Add a "fresh" peer
      table.addOrUpdate(makePeerUpdate({ peerId: 'fresh', idPrefix: makePrefix(1) }));

      // Add an "old" peer by manipulating lastSeen
      table.addOrUpdate(makePeerUpdate({ peerId: 'old', idPrefix: makePrefix(2), directlyConnected: true }));
      const oldPeer = table.getPeer('old')!;
      // Set lastSeen to 10 minutes ago (well beyond the 5-minute direct threshold)
      oldPeer.lastSeen = Date.now() - 10 * 60 * 1000;

      const pruned = table.pruneStale();
      expect(pruned).toBe(1);
      expect(table.getPeer('old')).toBeNull();
      expect(table.getPeer('fresh')).not.toBeNull();
    });

    it('uses default thresholds (5 min direct, 2 min relay)', () => {
      // Relay peer last seen 3 minutes ago -- should be pruned (2 min threshold)
      table.addOrUpdate(makePeerUpdate({
        peerId: 'stale-relay',
        idPrefix: makePrefix(1),
        directlyConnected: false,
        hopCount: 2,
      }));
      table.getPeer('stale-relay')!.lastSeen = Date.now() - 3 * 60 * 1000;

      // Direct peer last seen 3 minutes ago -- should NOT be pruned (5 min threshold)
      table.addOrUpdate(makePeerUpdate({
        peerId: 'ok-direct',
        idPrefix: makePrefix(2),
        directlyConnected: true,
      }));
      table.getPeer('ok-direct')!.lastSeen = Date.now() - 3 * 60 * 1000;

      const pruned = table.pruneStale();
      expect(pruned).toBe(1);
      expect(table.getPeer('stale-relay')).toBeNull();
      expect(table.getPeer('ok-direct')).not.toBeNull();
    });

    it('respects custom maxAgeMs override', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: makePrefix(1) }));
      table.getPeer('p1')!.lastSeen = Date.now() - 5000; // 5 seconds ago

      // With a 3-second max age, the peer should be pruned
      const pruned = table.pruneStale(3000);
      expect(pruned).toBe(1);
      expect(table.size).toBe(0);
    });

    it('returns 0 when no peers are stale', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: makePrefix(1) }));
      const pruned = table.pruneStale();
      expect(pruned).toBe(0);
    });

    it('returns 0 on empty table', () => {
      expect(table.pruneStale()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // markDisconnected
  // -----------------------------------------------------------------------

  describe('markDisconnected()', () => {
    it('transitions peer to not directly connected', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', directlyConnected: true }));
      expect(table.getPeer('p1')!.directlyConnected).toBe(true);

      table.markDisconnected('p1');
      expect(table.getPeer('p1')!.directlyConnected).toBe(false);
    });

    it('sets rssi to null', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', rssi: -55 }));
      table.markDisconnected('p1');
      expect(table.getPeer('p1')!.rssi).toBeNull();
    });

    it('peer remains in the table after disconnection', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1' }));
      table.markDisconnected('p1');
      expect(table.size).toBe(1);
      expect(table.getPeer('p1')).not.toBeNull();
    });

    it('is a no-op for unknown peerId', () => {
      // Should not throw
      expect(() => table.markDisconnected('nonexistent')).not.toThrow();
      expect(table.size).toBe(0);
    });

    it('peer no longer appears in getDirectPeers after disconnection', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', directlyConnected: true, idPrefix: makePrefix(1) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'p2', directlyConnected: true, idPrefix: makePrefix(2) }));

      table.markDisconnected('p1');

      const direct = table.getDirectPeers();
      const directIds = direct.map((p) => p.peerId);
      expect(directIds).toEqual(['p2']);
    });
  });

  // -----------------------------------------------------------------------
  // getPeer
  // -----------------------------------------------------------------------

  describe('getPeer()', () => {
    it('returns PeerInfo for existing peer', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1' }));
      const info = table.getPeer('p1');
      expect(info).not.toBeNull();
      expect(info!.peerId).toBe('p1');
    });

    it('returns null for unknown peerId', () => {
      expect(table.getPeer('unknown')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all entries', () => {
      table.addOrUpdate(makePeerUpdate({ peerId: 'p1', idPrefix: makePrefix(1) }));
      table.addOrUpdate(makePeerUpdate({ peerId: 'p2', idPrefix: makePrefix(2) }));
      expect(table.size).toBe(2);

      table.clear();
      expect(table.size).toBe(0);
      expect(table.getReachablePeers()).toEqual([]);
    });
  });
});
