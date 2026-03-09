/**
 * ConnectionBadge.tsx - Visual indicator of transport connection status.
 *
 * Displays a colored dot with a label reflecting the current transport
 * layer (BLE direct, mesh relay, Nostr bridge, or offline), plus an
 * optional peer count.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ConnectionStatus } from '../../store/appStore';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConnectionBadgeProps {
  status: ConnectionStatus;
  peerCount: number;
}

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  direct: '#34C759',  // green
  mesh: '#007AFF',    // blue
  nostr: '#AF52DE',   // purple
  offline: '#FF3B30', // red
};

const STATUS_LABEL_KEYS: Record<ConnectionStatus, string> = {
  direct: 'connection.direct',
  mesh: 'connection.mesh',
  nostr: 'connection.nostr',
  offline: 'connection.offline',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ConnectionBadge: React.FC<ConnectionBadgeProps> = ({
  status,
  peerCount,
}) => {
  const { t } = useTranslation();

  const dotColor = STATUS_COLORS[status];
  const label = t(STATUS_LABEL_KEYS[status]);

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: dotColor }]} />
      <Text style={styles.label}>{label}</Text>
      {peerCount > 0 && (
        <Text style={styles.peerCount}>
          {t('connection.peers_nearby', { count: peerCount })}
        </Text>
      )}
    </View>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#F2F2F7',
    borderRadius: 12,
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#3C3C43',
  },
  peerCount: {
    fontSize: 11,
    color: '#8E8E93',
    marginLeft: 4,
  },
});

export default ConnectionBadge;
