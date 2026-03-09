/**
 * i18n/index.ts - Internationalization configuration for Jisr.
 *
 * Supports three languages:
 *   - English (en) - default
 *   - Arabic  (ar) - RTL
 *   - French  (fr)
 *
 * Uses i18next with react-i18next integration.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { I18nManager } from 'react-native';

import en from './en.json';
import ar from './ar.json';
import fr from './fr.json';

// ---------------------------------------------------------------------------
// Resource bundles
// ---------------------------------------------------------------------------

const resources = {
  en: { translation: en },
  ar: { translation: ar },
  fr: { translation: fr },
};

// ---------------------------------------------------------------------------
// Supported languages metadata
// ---------------------------------------------------------------------------

export interface LanguageOption {
  code: string;
  label: string;
  nativeLabel: string;
  flag: string;
  isRTL: boolean;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية', flag: '\u{1F1F1}\u{1F1E7}', isRTL: true },
  { code: 'fr', label: 'French', nativeLabel: 'Fran\u00e7ais', flag: '\u{1F1EB}\u{1F1F7}', isRTL: false },
  { code: 'en', label: 'English', nativeLabel: 'English', flag: '\u{1F1EC}\u{1F1E7}', isRTL: false },
];

// ---------------------------------------------------------------------------
// Initialize i18next
// ---------------------------------------------------------------------------

i18n.use(initReactI18next).init({
  resources,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
});

// ---------------------------------------------------------------------------
// Language setter with RTL handling
// ---------------------------------------------------------------------------

/**
 * Set the active language and configure RTL layout for Arabic.
 *
 * This function:
 * 1. Changes the i18next language
 * 2. Forces RTL layout when Arabic is selected
 * 3. Reverts to LTR for other languages
 *
 * Note: After calling this with a change in RTL direction, a full app
 * restart may be required for React Native to properly apply the layout
 * direction change on some platforms.
 */
export function setLanguage(lang: string): void {
  i18n.changeLanguage(lang);

  const isRTL = lang === 'ar';
  I18nManager.forceRTL(isRTL);
  I18nManager.allowRTL(isRTL);
}

/**
 * Returns whether the current language is RTL.
 */
export function isCurrentLanguageRTL(): boolean {
  return i18n.language === 'ar';
}

export default i18n;
