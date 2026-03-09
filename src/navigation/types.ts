/**
 * navigation/types.ts - React Navigation type definitions for Jisr.
 *
 * Defines the root stack parameter list and typed hooks/props for
 * type-safe navigation throughout the app.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NavigationProp, RouteProp } from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';

// ---------------------------------------------------------------------------
// Root stack param list
// ---------------------------------------------------------------------------

export type RootStackParamList = {
  Onboarding: undefined;
  ContactList: undefined;
  Chat: {
    contactId: string;
    contactName: string;
    contactPubKey: string;
  };
  AddContact: undefined;
  Settings: undefined;
};

// ---------------------------------------------------------------------------
// Typed screen props
// ---------------------------------------------------------------------------

export type OnboardingScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'Onboarding'
>;

export type ContactListScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'ContactList'
>;

export type ChatScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'Chat'
>;

export type AddContactScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'AddContact'
>;

export type SettingsScreenProps = NativeStackScreenProps<
  RootStackParamList,
  'Settings'
>;

// ---------------------------------------------------------------------------
// Typed navigation hook
// ---------------------------------------------------------------------------

/**
 * Typed useNavigation hook for the root stack.
 * Usage: const navigation = useAppNavigation();
 */
export function useAppNavigation() {
  return useNavigation<NavigationProp<RootStackParamList>>();
}

/**
 * Typed useRoute hook for a specific screen.
 * Usage: const route = useAppRoute<'Chat'>();
 */
export function useAppRoute<T extends keyof RootStackParamList>() {
  return useRoute<RouteProp<RootStackParamList, T>>();
}
