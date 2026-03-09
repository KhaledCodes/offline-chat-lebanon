/**
 * OnboardingScreen.tsx - First-run setup wizard for Jisr.
 *
 * Four-step flow:
 *   1. Language selection (Arabic, French, English)
 *   2. Display name entry
 *   3. Key generation (Ed25519 identity keypair)
 *   4. Confirmation / "All set!" with Start button
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  Animated,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { setLanguage, SUPPORTED_LANGUAGES } from '../i18n';
import useAppStore from '../store/appStore';
import type { SupportedLanguage } from '../store/appStore';
import keyManager from '../crypto/KeyManager';
import type { OnboardingScreenProps } from '../navigation/types';

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type OnboardingStep = 'language' | 'name' | 'keys' | 'ready';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ navigation }) => {
  const { t } = useTranslation();

  const {
    setOnboarded,
    setDisplayName: storeSetDisplayName,
    setLanguage: storeSetLanguage,
    setPublicKey,
  } = useAppStore();

  const [step, setStep] = useState<OnboardingStep>('language');
  const [selectedLanguage, setSelectedLanguage] = useState<SupportedLanguage>('en');
  const [displayName, setDisplayName] = useState('');
  const [keyGenError, setKeyGenError] = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(1)).current;

  // -----------------------------------------------------------------------
  // Step transitions with fade animation
  // -----------------------------------------------------------------------

  const transitionTo = useCallback(
    (nextStep: OnboardingStep) => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => {
        setStep(nextStep);
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 250,
          useNativeDriver: true,
        }).start();
      });
    },
    [fadeAnim],
  );

  // -----------------------------------------------------------------------
  // Step 1: Language selection
  // -----------------------------------------------------------------------

  const handleLanguageSelect = useCallback(
    (langCode: SupportedLanguage) => {
      setSelectedLanguage(langCode);
      setLanguage(langCode);
      storeSetLanguage(langCode);
      transitionTo('name');
    },
    [storeSetLanguage, transitionTo],
  );

  // -----------------------------------------------------------------------
  // Step 2: Name entry
  // -----------------------------------------------------------------------

  const handleNameSubmit = useCallback(() => {
    const trimmed = displayName.trim();
    if (trimmed.length === 0) {
      return;
    }
    storeSetDisplayName(trimmed);
    keyManager.setDisplayName(trimmed);
    transitionTo('keys');
  }, [displayName, storeSetDisplayName, transitionTo]);

  // -----------------------------------------------------------------------
  // Step 3: Key generation
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (step !== 'keys') {
      return;
    }

    let cancelled = false;

    const generateKeys = async () => {
      try {
        await keyManager.initialize();
        if (cancelled) {
          return;
        }
        const pubKey = keyManager.getPublicKeyBase64Url();
        setPublicKey(pubKey);

        // Brief delay so the user sees the generation animation
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (cancelled) {
          return;
        }

        transitionTo('ready');
      } catch (err) {
        if (!cancelled) {
          setKeyGenError(
            err instanceof Error ? err.message : 'Key generation failed',
          );
        }
      }
    };

    generateKeys();

    return () => {
      cancelled = true;
    };
  }, [step, setPublicKey, transitionTo]);

  // -----------------------------------------------------------------------
  // Step 4: All set
  // -----------------------------------------------------------------------

  const handleStart = useCallback(() => {
    setOnboarded(true);
    navigation.reset({
      index: 0,
      routes: [{ name: 'ContactList' }],
    });
  }, [setOnboarded, navigation]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          {/* App title in Arabic calligraphy style */}
          <Text style={styles.arabicTitle}>{'\u062C\u0633\u0631'}</Text>
          <Text style={styles.latinTitle}>Jisr</Text>

          <Animated.View style={[styles.stepContainer, { opacity: fadeAnim }]}>
            {step === 'language' && (
              <LanguageStep onSelect={handleLanguageSelect} t={t} />
            )}

            {step === 'name' && (
              <NameStep
                displayName={displayName}
                onChangeName={setDisplayName}
                onSubmit={handleNameSubmit}
                t={t}
              />
            )}

            {step === 'keys' && (
              <KeyGenStep error={keyGenError} t={t} />
            )}

            {step === 'ready' && (
              <ReadyStep onStart={handleStart} t={t} />
            )}
          </Animated.View>

          {/* Step indicators */}
          <View style={styles.stepIndicators}>
            {(['language', 'name', 'keys', 'ready'] as OnboardingStep[]).map(
              (s) => (
                <View
                  key={s}
                  style={[
                    styles.stepDot,
                    step === s && styles.stepDotActive,
                  ]}
                />
              ),
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

interface StepProps {
  t: (key: string) => string;
}

const LanguageStep: React.FC<
  StepProps & { onSelect: (lang: SupportedLanguage) => void }
> = ({ onSelect, t }) => (
  <View style={styles.stepContent}>
    <Text style={styles.stepTitle}>{t('onboarding.choose_language')}</Text>
    <View style={styles.languageList}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <TouchableOpacity
          key={lang.code}
          style={styles.languageButton}
          onPress={() => onSelect(lang.code as SupportedLanguage)}
          activeOpacity={0.7}
          accessibilityLabel={lang.label}
          accessibilityRole="button"
        >
          <Text style={styles.languageFlag}>{lang.flag}</Text>
          <View style={styles.languageTextContainer}>
            <Text style={styles.languageNative}>{lang.nativeLabel}</Text>
            <Text style={styles.languageEnglish}>{lang.label}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

const NameStep: React.FC<
  StepProps & {
    displayName: string;
    onChangeName: (name: string) => void;
    onSubmit: () => void;
  }
> = ({ displayName, onChangeName, onSubmit, t }) => (
  <View style={styles.stepContent}>
    <Text style={styles.stepTitle}>{t('onboarding.enter_name')}</Text>
    <TextInput
      style={styles.nameInput}
      value={displayName}
      onChangeText={onChangeName}
      placeholder={t('onboarding.name_placeholder')}
      placeholderTextColor="#8E8E93"
      autoFocus
      maxLength={40}
      returnKeyType="done"
      onSubmitEditing={onSubmit}
      autoCapitalize="words"
      autoCorrect={false}
    />
    <TouchableOpacity
      style={[
        styles.primaryButton,
        displayName.trim().length === 0 && styles.primaryButtonDisabled,
      ]}
      onPress={onSubmit}
      disabled={displayName.trim().length === 0}
      activeOpacity={0.7}
    >
      <Text style={styles.primaryButtonText}>{t('common.confirm')}</Text>
    </TouchableOpacity>
  </View>
);

const KeyGenStep: React.FC<StepProps & { error: string | null }> = ({
  error,
  t,
}) => (
  <View style={styles.stepContent}>
    {error ? (
      <>
        <Text style={styles.errorText}>{t('common.error')}</Text>
        <Text style={styles.errorDetail}>{error}</Text>
      </>
    ) : (
      <>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.keyGenText}>{t('onboarding.generating_keys')}</Text>
      </>
    )}
  </View>
);

const ReadyStep: React.FC<StepProps & { onStart: () => void }> = ({
  onStart,
  t,
}) => (
  <View style={styles.stepContent}>
    <Text style={styles.readyIcon}>{'\u2705'}</Text>
    <Text style={styles.readyTitle}>{t('onboarding.ready')}</Text>
    <Text style={styles.readySubtitle}>{t('onboarding.subtitle')}</Text>
    <TouchableOpacity
      style={styles.primaryButton}
      onPress={onStart}
      activeOpacity={0.7}
    >
      <Text style={styles.primaryButtonText}>{t('onboarding.start')}</Text>
    </TouchableOpacity>
  </View>
);

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
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  arabicTitle: {
    fontSize: 56,
    fontWeight: '300',
    color: '#007AFF',
    marginBottom: 2,
  },
  latinTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#8E8E93',
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 40,
  },
  stepContainer: {
    width: '100%',
    alignItems: 'center',
  },
  stepContent: {
    width: '100%',
    alignItems: 'center',
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1C1C1E',
    marginBottom: 24,
    textAlign: 'center',
  },
  // Language step
  languageList: {
    width: '100%',
    gap: 12,
  },
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: '#F2F2F7',
    borderRadius: 14,
    gap: 16,
  },
  languageFlag: {
    fontSize: 32,
  },
  languageTextContainer: {
    flex: 1,
  },
  languageNative: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  languageEnglish: {
    fontSize: 14,
    color: '#8E8E93',
    marginTop: 2,
  },
  // Name step
  nameInput: {
    width: '100%',
    fontSize: 18,
    color: '#1C1C1E',
    borderBottomWidth: 2,
    borderBottomColor: '#007AFF',
    paddingVertical: 12,
    marginBottom: 32,
    textAlign: 'center',
  },
  // Key generation step
  keyGenText: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 20,
    textAlign: 'center',
  },
  // Error
  errorText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#FF3B30',
    marginBottom: 8,
  },
  errorDetail: {
    fontSize: 14,
    color: '#8E8E93',
    textAlign: 'center',
  },
  // Ready step
  readyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  readyTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#1C1C1E',
    marginBottom: 8,
  },
  readySubtitle: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    marginBottom: 40,
  },
  // Shared button
  primaryButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    paddingHorizontal: 48,
    borderRadius: 14,
    minWidth: 200,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: '#C7C7CC',
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Step indicators
  stepIndicators: {
    flexDirection: 'row',
    gap: 8,
    position: 'absolute',
    bottom: 48,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#D1D1D6',
  },
  stepDotActive: {
    backgroundColor: '#007AFF',
    width: 24,
  },
});

export default OnboardingScreen;
