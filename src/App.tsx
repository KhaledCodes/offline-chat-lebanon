/**
 * App.tsx - Root component for the Jisr BLE mesh chat app.
 *
 * Responsibilities:
 *   - Initialize i18n with the user's preferred language
 *   - Set up React Navigation with a native stack navigator
 *   - Conditionally render OnboardingScreen or the main contact flow
 *   - Provide navigation theme (light/dark)
 *   - Initialize BLE peer discovery on mount
 */

import React, { useEffect } from 'react';
import { StatusBar, I18nManager } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import './i18n';
import { setLanguage } from './i18n';
import useAppStore from './store/appStore';
import PeerDiscovery from './ble/PeerDiscovery';
import type { RootStackParamList } from './navigation/types';

// Screens
import OnboardingScreen from './screens/OnboardingScreen';
import ContactListScreen from './screens/ContactListScreen';
import ChatScreen from './screens/ChatScreen';
import AddContactScreen from './screens/AddContactScreen';
import SettingsScreen from './screens/SettingsScreen';

// ---------------------------------------------------------------------------
// Navigation stack
// ---------------------------------------------------------------------------

const Stack = createNativeStackNavigator<RootStackParamList>();

// ---------------------------------------------------------------------------
// Navigation theme
// ---------------------------------------------------------------------------

const JisrLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: '#007AFF',
    background: '#FFFFFF',
    card: '#FFFFFF',
    text: '#1C1C1E',
    border: '#E5E5EA',
    notification: '#FF3B30',
  },
};

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

const App: React.FC = () => {
  const { isOnboarded, language, setNearbyPeers } = useAppStore();
  const { t } = useTranslation();

  // -----------------------------------------------------------------------
  // Restore language preference and RTL on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    setLanguage(language);
  }, [language]);

  // -----------------------------------------------------------------------
  // Initialize peer discovery
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (!isOnboarded) {
      return;
    }

    const discovery = PeerDiscovery.getInstance();
    discovery.start();

    const unsubscribe = discovery.onChange((peers) => {
      setNearbyPeers(peers);
    });

    return () => {
      unsubscribe();
      discovery.stop();
    };
  }, [isOnboarded, setNearbyPeers]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaProvider>
      <StatusBar
        barStyle="dark-content"
        backgroundColor="#FFFFFF"
        translucent={false}
      />
      <NavigationContainer theme={JisrLightTheme}>
        <Stack.Navigator
          screenOptions={{
            headerBackTitle: '',
            headerTitleAlign: 'center',
            headerShadowVisible: false,
            headerStyle: {
              backgroundColor: '#FFFFFF',
            },
            headerTintColor: '#007AFF',
            animation: I18nManager.isRTL ? 'slide_from_left' : 'slide_from_right',
          }}
        >
          {!isOnboarded ? (
            <Stack.Screen
              name="Onboarding"
              component={OnboardingScreen}
              options={{ headerShown: false }}
            />
          ) : (
            <>
              <Stack.Screen
                name="ContactList"
                component={ContactListScreen}
                options={{
                  title: t('contacts.title'),
                }}
              />
              <Stack.Screen
                name="Chat"
                component={ChatScreen}
                options={{
                  title: '',
                }}
              />
              <Stack.Screen
                name="AddContact"
                component={AddContactScreen}
                options={{
                  title: t('add_contact.title'),
                  presentation: 'modal',
                }}
              />
              <Stack.Screen
                name="Settings"
                component={SettingsScreen}
                options={{
                  title: t('settings.title'),
                }}
              />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
};

export default App;
