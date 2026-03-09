/**
 * appStore.ts - Global application state managed by Zustand.
 *
 * Persists critical state (onboarding, identity, preferences) to MMKV
 * so the app can restore state across cold starts without network access.
 *
 * Transient state (nearby peers, active conversation) is NOT persisted.
 */

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { MMKV } from 'react-native-mmkv';
import type { PeerInfo } from '../ble/PeerDiscovery';

// ---------------------------------------------------------------------------
// MMKV storage adapter for Zustand persist middleware
// ---------------------------------------------------------------------------

const mmkvStore = new MMKV({
  id: 'jisr-app-store',
});

const mmkvStorage: StateStorage = {
  getItem: (name: string): string | null => {
    return mmkvStore.getString(name) ?? null;
  },
  setItem: (name: string, value: string): void => {
    mmkvStore.set(name, value);
  },
  removeItem: (name: string): void => {
    mmkvStore.delete(name);
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionStatus = 'direct' | 'mesh' | 'nostr' | 'offline';
export type SupportedLanguage = 'en' | 'ar' | 'fr';

export interface AppState {
  // Persisted state
  isOnboarded: boolean;
  displayName: string;
  language: SupportedLanguage;
  publicKey: string; // base64url encoded Ed25519 public key

  // Transient state (not persisted)
  nearbyPeers: PeerInfo[];
  connectionStatus: ConnectionStatus;
  activeConversationId: string | null;
}

export interface AppActions {
  setOnboarded: (value: boolean) => void;
  setDisplayName: (name: string) => void;
  setLanguage: (lang: SupportedLanguage) => void;
  setPublicKey: (key: string) => void;
  setNearbyPeers: (peers: PeerInfo[]) => void;
  setConnectionStatus: (status: ConnectionStatus) => void;
  setActiveConversation: (conversationId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useAppStore = create<AppState & AppActions>()(
  persist(
    (set) => ({
      // ----- Persisted defaults -----
      isOnboarded: false,
      displayName: '',
      language: 'en',
      publicKey: '',

      // ----- Transient defaults -----
      nearbyPeers: [],
      connectionStatus: 'offline',
      activeConversationId: null,

      // ----- Actions -----
      setOnboarded: (value: boolean) => set({ isOnboarded: value }),

      setDisplayName: (name: string) => set({ displayName: name }),

      setLanguage: (lang: SupportedLanguage) => set({ language: lang }),

      setPublicKey: (key: string) => set({ publicKey: key }),

      setNearbyPeers: (peers: PeerInfo[]) => set({ nearbyPeers: peers }),

      setConnectionStatus: (status: ConnectionStatus) =>
        set({ connectionStatus: status }),

      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId }),
    }),
    {
      name: 'jisr-app-state',
      storage: createJSONStorage(() => mmkvStorage),
      // Only persist these fields; transient state is excluded
      partialize: (state) => ({
        isOnboarded: state.isOnboarded,
        displayName: state.displayName,
        language: state.language,
        publicKey: state.publicKey,
      }),
    },
  ),
);

export default useAppStore;
