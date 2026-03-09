/**
 * MessageList.tsx - Inverted FlatList wrapper for displaying chat messages.
 *
 * Renders messages in reverse chronological order (newest at bottom)
 * using React Native's inverted FlatList. Delegates rendering of
 * individual messages to MessageBubble.
 */

import React, { useCallback, useRef } from 'react';
import {
  FlatList,
  View,
  Text,
  StyleSheet,
  type ListRenderItemInfo,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import MessageBubble, { type Message } from './MessageBubble';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MessageListProps {
  /** Array of messages to display, ordered oldest to newest. */
  messages: Message[];
  /** The current user's sender ID for determining message ownership. */
  currentUserId: string;
  /** Optional callback triggered when the user scrolls near the top (oldest messages). */
  onLoadMore?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MessageList: React.FC<MessageListProps> = ({
  messages,
  currentUserId,
  onLoadMore,
}) => {
  const { t } = useTranslation();
  const flatListRef = useRef<FlatList<Message>>(null);

  // The FlatList is inverted, so the data should be reversed:
  // newest messages appear at the bottom (index 0 in inverted list).
  const invertedMessages = [...messages].reverse();

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => {
      const isMine = item.senderId === currentUserId;
      return <MessageBubble message={item} isMine={isMine} />;
    },
    [currentUserId],
  );

  const keyExtractor = useCallback(
    (item: Message) => item.id,
    [],
  );

  const handleEndReached = useCallback(() => {
    if (onLoadMore) {
      onLoadMore();
    }
  }, [onLoadMore]);

  const renderListHeader = useCallback(() => {
    // In an inverted list, ListHeaderComponent appears at the bottom
    return <View style={styles.bottomSpacer} />;
  }, []);

  const renderListFooter = useCallback(() => {
    // In an inverted list, ListFooterComponent appears at the top
    return (
      <View style={styles.encryptionNotice}>
        <Text style={styles.lockIcon}>{'\uD83D\uDD12'}</Text>
        <Text style={styles.encryptionText}>
          {t('chat.encryption_notice')}
        </Text>
      </View>
    );
  }, [t]);

  const renderEmptyComponent = useCallback(() => {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {t('chat.encryption_notice')}
        </Text>
      </View>
    );
  }, [t]);

  return (
    <FlatList
      ref={flatListRef}
      data={invertedMessages}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      inverted
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.3}
      ListHeaderComponent={renderListHeader}
      ListFooterComponent={renderListFooter}
      ListEmptyComponent={renderEmptyComponent}
      // Performance optimizations
      removeClippedSubviews
      maxToRenderPerBatch={20}
      windowSize={15}
      initialNumToRender={25}
      getItemLayout={undefined} // dynamic heights
    />
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  contentContainer: {
    paddingVertical: 8,
    flexGrow: 1,
  },
  bottomSpacer: {
    height: 4,
  },
  encryptionNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    gap: 6,
  },
  lockIcon: {
    fontSize: 12,
  },
  encryptionText: {
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    // Inverted list: this will appear centered
    transform: [{ scaleY: -1 }],
  },
  emptyText: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
  },
});

export default MessageList;
