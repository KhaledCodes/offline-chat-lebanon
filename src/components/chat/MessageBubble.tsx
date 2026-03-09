/**
 * MessageBubble.tsx - Individual chat message bubble.
 *
 * Renders sent messages right-aligned with a blue background and received
 * messages left-aligned with a light gray background. Includes timestamp
 * and delivery status indicators for outbound messages.
 *
 * Supports RTL layout natively via React Native's I18nManager.
 */

import React from 'react';
import { View, Text, StyleSheet, I18nManager } from 'react-native';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  timestamp: number;
  status: 'pending' | 'sent' | 'delivered' | 'read';
  transport?: 'ble' | 'mesh' | 'nostr' | 'local';
}

export interface MessageBubbleProps {
  message: Message;
  isMine: boolean;
}

// ---------------------------------------------------------------------------
// Status icon mapping
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<Message['status'], string> = {
  pending: '\u23F3', // hourglass
  sent: '\u2713',    // single check
  delivered: '\u2713\u2713', // double check
  read: '\u2713\u2713',     // double check (styled differently)
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isMine }) => {
  const { t } = useTranslation();

  const formattedTime = formatTimestamp(message.timestamp);

  const statusLabel = getStatusLabel(message.status, t);
  const statusIcon = STATUS_ICONS[message.status];

  return (
    <View
      style={[
        styles.wrapper,
        isMine ? styles.wrapperSent : styles.wrapperReceived,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isMine ? styles.bubbleSent : styles.bubbleReceived,
        ]}
      >
        <Text
          style={[
            styles.messageText,
            isMine ? styles.textSent : styles.textReceived,
          ]}
        >
          {message.content}
        </Text>
        <View style={styles.metaRow}>
          <Text
            style={[
              styles.timestamp,
              isMine ? styles.timestampSent : styles.timestampReceived,
            ]}
          >
            {formattedTime}
          </Text>
          {isMine && (
            <Text
              style={[
                styles.statusIcon,
                message.status === 'read' && styles.statusRead,
              ]}
              accessibilityLabel={statusLabel}
            >
              {statusIcon}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getStatusLabel(
  status: Message['status'],
  t: (key: string) => string,
): string {
  switch (status) {
    case 'pending':
      return t('chat.pending');
    case 'sent':
      return t('chat.sent');
    case 'delivered':
      return t('chat.delivered');
    case 'read':
      return t('chat.read');
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  wrapper: {
    paddingHorizontal: 12,
    paddingVertical: 2,
    width: '100%',
  },
  wrapperSent: {
    alignItems: 'flex-end',
  },
  wrapperReceived: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  bubbleSent: {
    backgroundColor: '#007AFF',
    borderBottomRightRadius: I18nManager.isRTL ? 18 : 4,
    borderBottomLeftRadius: I18nManager.isRTL ? 4 : 18,
  },
  bubbleReceived: {
    backgroundColor: '#E5E5EA',
    borderBottomLeftRadius: I18nManager.isRTL ? 18 : 4,
    borderBottomRightRadius: I18nManager.isRTL ? 4 : 18,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 22,
  },
  textSent: {
    color: '#FFFFFF',
  },
  textReceived: {
    color: '#1C1C1E',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 2,
    gap: 4,
  },
  timestamp: {
    fontSize: 11,
  },
  timestampSent: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  timestampReceived: {
    color: '#8E8E93',
  },
  statusIcon: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  statusRead: {
    color: '#A8D8FF',
  },
});

export default MessageBubble;
