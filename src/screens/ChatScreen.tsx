/**
 * ChatScreen.tsx - Individual conversation view.
 *
 * Displays an inverted message list with a message input bar at the
 * bottom. Shows the contact name and connection type in the header,
 * and an encryption notice at the top of the message history.
 */

import React, { useCallback, useMemo, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import useAppStore from '../store/appStore';
import MessageList from '../components/chat/MessageList';
import MessageInput from '../components/chat/MessageInput';
import ConnectionBadge from '../components/common/ConnectionBadge';
import type { Message } from '../components/chat/MessageBubble';
import type { ChatScreenProps } from '../navigation/types';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ChatScreen: React.FC<ChatScreenProps> = ({ route, navigation }) => {
  const { contactId, contactName, contactPubKey } = route.params;
  const { t } = useTranslation();

  const {
    publicKey,
    connectionStatus,
    nearbyPeers,
    setActiveConversation,
  } = useAppStore();

  // Track active conversation for notification suppression
  useEffect(() => {
    setActiveConversation(contactId);
    return () => {
      setActiveConversation(null);
    };
  }, [contactId, setActiveConversation]);

  // TODO: Replace with actual messages from database
  const messages: Message[] = useMemo(() => [], []);

  // -----------------------------------------------------------------------
  // Header configuration
  // -----------------------------------------------------------------------

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitleContainer}>
          <Text style={styles.headerName} numberOfLines={1}>
            {contactName}
          </Text>
          <ConnectionBadge
            status={connectionStatus}
            peerCount={nearbyPeers.length}
          />
        </View>
      ),
    });
  }, [navigation, contactName, connectionStatus, nearbyPeers.length]);

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleSend = useCallback(
    (text: string) => {
      // TODO: Implement actual message sending via BLE/mesh/Nostr
      const newMessage: Message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        conversationId: contactId,
        senderId: publicKey,
        content: text,
        timestamp: Date.now(),
        status: 'pending',
      };

      // In production, this would:
      // 1. Encrypt the message with the contact's public key
      // 2. Store in local database
      // 3. Send via the appropriate transport (BLE direct, mesh, or Nostr)
      // 4. Update status to 'sent' on successful transmission
      console.log('[ChatScreen] Sending message:', newMessage);
    },
    [contactId, publicKey],
  );

  const handleLoadMore = useCallback(() => {
    // TODO: Load older messages from database
    console.log('[ChatScreen] Loading more messages...');
  }, []);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={styles.container}>
          <MessageList
            messages={messages}
            currentUserId={publicKey}
            onLoadMore={handleLoadMore}
          />
          <MessageInput
            onSend={handleSend}
            disabled={connectionStatus === 'offline'}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  headerTitleContainer: {
    alignItems: 'center',
    gap: 4,
  },
  headerName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1C1E',
  },
});

export default ChatScreen;
