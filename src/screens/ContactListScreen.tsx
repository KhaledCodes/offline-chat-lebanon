/**
 * ContactListScreen.tsx - Main contact list with message previews.
 *
 * Displays all known contacts in a FlatList with:
 *   - Deterministic avatar color derived from the contact's public key
 *   - Display name
 *   - Last message preview and timestamp
 *   - Connection status badge in header
 *   - FAB button to add new contacts
 */

import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
  type ListRenderItemInfo,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import useAppStore from '../store/appStore';
import ConnectionBadge from '../components/common/ConnectionBadge';
import type { ContactListScreenProps } from '../navigation/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContactItem {
  id: string;
  displayName: string;
  publicKey: string;
  lastMessage?: string;
  lastMessageTimestamp?: number;
  unreadCount?: number;
}

// ---------------------------------------------------------------------------
// Avatar color generation
// ---------------------------------------------------------------------------

const AVATAR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
  '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
  '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#D7BDE2',
];

/**
 * Generate a deterministic avatar color from a public key string.
 * Uses a simple hash of the first few characters.
 */
function getAvatarColor(pubKey: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(pubKey.length, 16); i++) {
    hash = ((hash << 5) - hash + pubKey.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/**
 * Get the initials (first letter or first two letters) from a display name.
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name[0] ?? '?').toUpperCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ContactListScreen: React.FC<ContactListScreenProps> = ({ navigation }) => {
  const { t } = useTranslation();
  const { connectionStatus, nearbyPeers } = useAppStore();

  // TODO: Replace with actual contacts from database
  const contacts: ContactItem[] = useMemo(() => [], []);

  const [refreshing, setRefreshing] = React.useState(false);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // TODO: Refresh contacts from database and trigger peer discovery
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setRefreshing(false);
  }, []);

  const handleContactPress = useCallback(
    (contact: ContactItem) => {
      navigation.navigate('Chat', {
        contactId: contact.id,
        contactName: contact.displayName,
        contactPubKey: contact.publicKey,
      });
    },
    [navigation],
  );

  const handleAddContact = useCallback(() => {
    navigation.navigate('AddContact');
  }, [navigation]);

  const handleSettingsPress = useCallback(() => {
    navigation.navigate('Settings');
  }, [navigation]);

  // -----------------------------------------------------------------------
  // Render helpers
  // -----------------------------------------------------------------------

  const renderContact = useCallback(
    ({ item }: ListRenderItemInfo<ContactItem>) => {
      const avatarColor = getAvatarColor(item.publicKey);
      const initials = getInitials(item.displayName);
      const timeLabel = item.lastMessageTimestamp
        ? formatRelativeTime(item.lastMessageTimestamp)
        : '';

      return (
        <TouchableOpacity
          style={styles.contactRow}
          onPress={() => handleContactPress(item)}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={item.displayName}
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor }]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={styles.contactInfo}>
            <View style={styles.contactTopRow}>
              <Text style={styles.contactName} numberOfLines={1}>
                {item.displayName}
              </Text>
              {timeLabel ? (
                <Text style={styles.contactTime}>{timeLabel}</Text>
              ) : null}
            </View>
            {item.lastMessage ? (
              <Text style={styles.lastMessage} numberOfLines={1}>
                {item.lastMessage}
              </Text>
            ) : null}
          </View>
          {item.unreadCount && item.unreadCount > 0 ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadText}>{item.unreadCount}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      );
    },
    [handleContactPress],
  );

  const keyExtractor = useCallback(
    (item: ContactItem) => item.id,
    [],
  );

  const renderEmptyList = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>{'\uD83D\uDCE1'}</Text>
        <Text style={styles.emptyTitle}>{t('contacts.no_contacts')}</Text>
        <Text style={styles.emptySubtitle}>
          {t('onboarding.subtitle')}
        </Text>
        <TouchableOpacity
          style={styles.emptyButton}
          onPress={handleAddContact}
          activeOpacity={0.7}
        >
          <Text style={styles.emptyButtonText}>
            {t('contacts.add_contact')}
          </Text>
        </TouchableOpacity>
      </View>
    ),
    [t, handleAddContact],
  );

  // -----------------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------------

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <Text style={styles.headerTitle}>{t('contacts.title')}</Text>
      ),
      headerRight: () => (
        <View style={styles.headerRight}>
          <ConnectionBadge
            status={connectionStatus}
            peerCount={nearbyPeers.length}
          />
          <TouchableOpacity
            onPress={handleSettingsPress}
            style={styles.settingsButton}
            accessibilityLabel={t('settings.title')}
          >
            <Text style={styles.settingsIcon}>{'\u2699\uFE0F'}</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [
    navigation,
    t,
    connectionStatus,
    nearbyPeers.length,
    handleSettingsPress,
  ]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <FlatList
        data={contacts}
        renderItem={renderContact}
        keyExtractor={keyExtractor}
        contentContainerStyle={
          contacts.length === 0 ? styles.emptyListContent : styles.listContent
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyList}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />

      {/* Floating Action Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleAddContact}
        activeOpacity={0.8}
        accessibilityLabel={t('contacts.add_contact')}
        accessibilityRole="button"
      >
        <Text style={styles.fabIcon}>+</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    if (days === 1) {
      return 'Yesterday';
    }
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return 'Now';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsButton: {
    padding: 4,
  },
  settingsIcon: {
    fontSize: 22,
  },
  listContent: {
    paddingBottom: 80,
  },
  emptyListContent: {
    flex: 1,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  contactInfo: {
    flex: 1,
  },
  contactTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  contactName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1C1E',
    flex: 1,
  },
  contactTime: {
    fontSize: 13,
    color: '#8E8E93',
    marginLeft: 8,
  },
  lastMessage: {
    fontSize: 14,
    color: '#8E8E93',
    marginTop: 2,
  },
  unreadBadge: {
    backgroundColor: '#007AFF',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 78,
  },
  // Empty state
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1C1C1E',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#8E8E93',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  emptyButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 12,
  },
  emptyButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 30,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#007AFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
  fabIcon: {
    fontSize: 28,
    color: '#FFFFFF',
    fontWeight: '300',
    marginTop: -1,
  },
});

export default ContactListScreen;
