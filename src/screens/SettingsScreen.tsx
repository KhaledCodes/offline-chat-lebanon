/**
 * SettingsScreen.tsx - App configuration and user preferences.
 *
 * Sections:
 *   - Profile: display name, public key
 *   - Preferences: language selector
 *   - Network: Nostr relay list
 *   - About: version, app description
 *   - Danger zone: clear all data
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  SafeAreaView,
  Alert,
  Clipboard,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { MMKV } from 'react-native-mmkv';
import useAppStore from '../store/appStore';
import type { SupportedLanguage } from '../store/appStore';
import { setLanguage, SUPPORTED_LANGUAGES } from '../i18n';
import keyManager from '../crypto/KeyManager';
import type { SettingsScreenProps } from '../navigation/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_VERSION = '0.1.0';

const DEFAULT_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SettingsScreen: React.FC<SettingsScreenProps> = ({ navigation }) => {
  const { t } = useTranslation();

  const {
    displayName,
    publicKey,
    language,
    setDisplayName: storeSetDisplayName,
    setLanguage: storeSetLanguage,
    setOnboarded,
  } = useAppStore();

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(displayName);
  const [showLanguagePicker, setShowLanguagePicker] = useState(false);

  // -----------------------------------------------------------------------
  // Profile: Display name editing
  // -----------------------------------------------------------------------

  const handleStartEditName = useCallback(() => {
    setEditedName(displayName);
    setIsEditingName(true);
  }, [displayName]);

  const handleSaveName = useCallback(() => {
    const trimmed = editedName.trim();
    if (trimmed.length > 0) {
      storeSetDisplayName(trimmed);
      keyManager.setDisplayName(trimmed);
    }
    setIsEditingName(false);
  }, [editedName, storeSetDisplayName]);

  const handleCancelEditName = useCallback(() => {
    setEditedName(displayName);
    setIsEditingName(false);
  }, [displayName]);

  // -----------------------------------------------------------------------
  // Profile: Copy public key
  // -----------------------------------------------------------------------

  const handleCopyPublicKey = useCallback(() => {
    if (publicKey) {
      Clipboard.setString(publicKey);
      Alert.alert('', 'Public key copied to clipboard');
    }
  }, [publicKey]);

  // -----------------------------------------------------------------------
  // Preferences: Language
  // -----------------------------------------------------------------------

  const handleLanguageSelect = useCallback(
    (langCode: SupportedLanguage) => {
      setLanguage(langCode);
      storeSetLanguage(langCode);
      setShowLanguagePicker(false);
    },
    [storeSetLanguage],
  );

  // -----------------------------------------------------------------------
  // Danger zone: Clear all data
  // -----------------------------------------------------------------------

  const handleClearData = useCallback(() => {
    Alert.alert(
      t('settings.clear_data'),
      t('common.confirm') + '?',
      [
        {
          text: t('common.cancel'),
          style: 'cancel',
        },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            // Clear MMKV stores
            try {
              const appStorage = new MMKV({ id: 'jisr-app-store' });
              appStorage.clearAll();

              const identityStorage = new MMKV({
                id: 'jisr-identity',
                encryptionKey: 'jisr-identity-store-v1',
              });
              identityStorage.clearAll();
            } catch {
              // Ignore storage clearing errors
            }

            // Reset store state
            setOnboarded(false);

            // Navigate back to onboarding
            navigation.reset({
              index: 0,
              routes: [{ name: 'Onboarding' }],
            });
          },
        },
      ],
    );
  }, [t, setOnboarded, navigation]);

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  const truncatedPublicKey = publicKey
    ? `${publicKey.slice(0, 12)}...${publicKey.slice(-8)}`
    : '';

  const currentLanguageLabel = SUPPORTED_LANGUAGES.find(
    (l) => l.code === language,
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
      >
        {/* ---- Profile Section ---- */}
        <Text style={styles.sectionHeader}>
          {t('settings.display_name').toUpperCase()}
        </Text>
        <View style={styles.section}>
          {isEditingName ? (
            <View style={styles.editRow}>
              <TextInput
                style={styles.editInput}
                value={editedName}
                onChangeText={setEditedName}
                autoFocus
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={handleSaveName}
              />
              <TouchableOpacity onPress={handleSaveName} style={styles.editAction}>
                <Text style={styles.saveText}>{t('common.save')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCancelEditName}
                style={styles.editAction}
              >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.settingRow}
              onPress={handleStartEditName}
              activeOpacity={0.6}
            >
              <Text style={styles.settingLabel}>
                {t('settings.display_name')}
              </Text>
              <Text style={styles.settingValue}>{displayName}</Text>
            </TouchableOpacity>
          )}
          <View style={styles.rowSeparator} />
          <TouchableOpacity
            style={styles.settingRow}
            onPress={handleCopyPublicKey}
            activeOpacity={0.6}
          >
            <Text style={styles.settingLabel}>{t('settings.public_key')}</Text>
            <Text style={styles.settingValueMono}>{truncatedPublicKey}</Text>
          </TouchableOpacity>
        </View>

        {/* ---- Preferences Section ---- */}
        <Text style={styles.sectionHeader}>
          {t('settings.language').toUpperCase()}
        </Text>
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.settingRow}
            onPress={() => setShowLanguagePicker(!showLanguagePicker)}
            activeOpacity={0.6}
          >
            <Text style={styles.settingLabel}>{t('settings.language')}</Text>
            <Text style={styles.settingValue}>
              {currentLanguageLabel
                ? `${currentLanguageLabel.flag} ${currentLanguageLabel.nativeLabel}`
                : language}
            </Text>
          </TouchableOpacity>

          {showLanguagePicker && (
            <View style={styles.languagePicker}>
              {SUPPORTED_LANGUAGES.map((lang) => (
                <TouchableOpacity
                  key={lang.code}
                  style={[
                    styles.languageOption,
                    lang.code === language && styles.languageOptionActive,
                  ]}
                  onPress={() =>
                    handleLanguageSelect(lang.code as SupportedLanguage)
                  }
                  activeOpacity={0.6}
                >
                  <Text style={styles.languageFlag}>{lang.flag}</Text>
                  <Text style={styles.languageLabel}>{lang.nativeLabel}</Text>
                  {lang.code === language && (
                    <Text style={styles.checkmark}>{'\u2713'}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* ---- Network Section ---- */}
        <Text style={styles.sectionHeader}>
          {t('settings.nostr_relays').toUpperCase()}
        </Text>
        <View style={styles.section}>
          {DEFAULT_NOSTR_RELAYS.map((relay, index) => (
            <React.Fragment key={relay}>
              <View style={styles.settingRow}>
                <Text style={styles.settingValueMono}>{relay}</Text>
              </View>
              {index < DEFAULT_NOSTR_RELAYS.length - 1 && (
                <View style={styles.rowSeparator} />
              )}
            </React.Fragment>
          ))}
        </View>

        {/* ---- About Section ---- */}
        <Text style={styles.sectionHeader}>
          {t('settings.about').toUpperCase()}
        </Text>
        <View style={styles.section}>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>{t('settings.version')}</Text>
            <Text style={styles.settingValue}>{APP_VERSION}</Text>
          </View>
          <View style={styles.rowSeparator} />
          <View style={styles.aboutRow}>
            <Text style={styles.aboutText}>{t('settings.about_text')}</Text>
          </View>
        </View>

        {/* ---- Danger Zone ---- */}
        <View style={[styles.section, styles.dangerSection]}>
          <TouchableOpacity
            style={styles.dangerRow}
            onPress={handleClearData}
            activeOpacity={0.6}
          >
            <Text style={styles.dangerText}>{t('settings.clear_data')}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    paddingTop: 16,
  },
  // Section
  sectionHeader: {
    fontSize: 13,
    fontWeight: '400',
    color: '#6C6C70',
    marginLeft: 16,
    marginBottom: 6,
    marginTop: 24,
    letterSpacing: 0.5,
  },
  section: {
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    borderRadius: 10,
    overflow: 'hidden',
  },
  // Setting rows
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    minHeight: 44,
  },
  settingLabel: {
    fontSize: 16,
    color: '#1C1C1E',
  },
  settingValue: {
    fontSize: 16,
    color: '#8E8E93',
  },
  settingValueMono: {
    fontSize: 13,
    color: '#8E8E93',
    fontFamily: 'monospace',
  },
  rowSeparator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#C6C6C8',
    marginLeft: 16,
  },
  // Edit name
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  editInput: {
    flex: 1,
    fontSize: 16,
    color: '#1C1C1E',
    borderBottomWidth: 1,
    borderBottomColor: '#007AFF',
    paddingVertical: 6,
  },
  editAction: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  saveText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#007AFF',
  },
  cancelText: {
    fontSize: 15,
    color: '#8E8E93',
  },
  // Language picker
  languagePicker: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C6C6C8',
  },
  languageOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  languageOptionActive: {
    backgroundColor: '#F2F2F7',
  },
  languageFlag: {
    fontSize: 22,
  },
  languageLabel: {
    fontSize: 16,
    color: '#1C1C1E',
    flex: 1,
  },
  checkmark: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: '600',
  },
  // About
  aboutRow: {
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  aboutText: {
    fontSize: 14,
    color: '#6C6C70',
    lineHeight: 20,
  },
  // Danger zone
  dangerSection: {
    marginTop: 40,
  },
  dangerRow: {
    paddingHorizontal: 16,
    paddingVertical: 13,
    alignItems: 'center',
  },
  dangerText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#FF3B30',
  },
  bottomSpacer: {
    height: 40,
  },
});

export default SettingsScreen;
