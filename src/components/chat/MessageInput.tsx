/**
 * MessageInput.tsx - Text input bar with send button for chat.
 *
 * The send button is only enabled when the input contains non-whitespace
 * text. Supports RTL text input and adapts to the current language
 * direction automatically.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  I18nManager,
} from 'react-native';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MessageInputProps {
  /** Called when the user taps the send button with the trimmed message text. */
  onSend: (text: string) => void;
  /** Whether the input should be disabled (e.g. no connection). */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MessageInput: React.FC<MessageInputProps> = ({
  onSend,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  const trimmedText = text.trim();
  const canSend = trimmedText.length > 0 && !disabled;

  const handleSend = useCallback(() => {
    if (!canSend) {
      return;
    }
    onSend(trimmedText);
    setText('');
  }, [canSend, onSend, trimmedText]);

  return (
    <View style={styles.container}>
      <View style={styles.inputWrapper}>
        <TextInput
          style={[
            styles.input,
            I18nManager.isRTL && styles.inputRTL,
          ]}
          value={text}
          onChangeText={setText}
          placeholder={t('chat.placeholder')}
          placeholderTextColor="#8E8E93"
          multiline
          maxLength={2000}
          editable={!disabled}
          textAlignVertical="center"
          returnKeyType="default"
        />
      </View>
      <TouchableOpacity
        style={[
          styles.sendButton,
          canSend ? styles.sendButtonActive : styles.sendButtonDisabled,
        ]}
        onPress={handleSend}
        disabled={!canSend}
        activeOpacity={0.7}
        accessibilityLabel={t('chat.send')}
        accessibilityRole="button"
      >
        <Text
          style={[
            styles.sendButtonText,
            canSend
              ? styles.sendButtonTextActive
              : styles.sendButtonTextDisabled,
          ]}
        >
          {'\u2191'}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#F2F2F7',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C6C6C8',
    gap: 8,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#C6C6C8',
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 120,
    justifyContent: 'center',
  },
  input: {
    fontSize: 16,
    color: '#1C1C1E',
    lineHeight: 22,
    paddingVertical: 0,
    textAlign: 'left',
  },
  inputRTL: {
    textAlign: 'right',
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  sendButtonActive: {
    backgroundColor: '#007AFF',
  },
  sendButtonDisabled: {
    backgroundColor: '#E5E5EA',
  },
  sendButtonText: {
    fontSize: 18,
    fontWeight: '700',
  },
  sendButtonTextActive: {
    color: '#FFFFFF',
  },
  sendButtonTextDisabled: {
    color: '#C7C7CC',
  },
});

export default MessageInput;
