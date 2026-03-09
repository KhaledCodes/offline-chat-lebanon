/**
 * AddContactScreen.tsx - Add a contact via QR code exchange.
 *
 * Two tabs:
 *   1. "Show My QR" - Displays the user's contact QR code for others to scan
 *   2. "Scan QR" - Camera view to scan another user's QR code
 *
 * On successful scan, the contact URI is parsed and the user is prompted
 * to confirm adding the new contact.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  Alert,
  Animated,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  useCameraDevice,
  useCodeScanner,
} from 'react-native-vision-camera';
import keyManager from '../crypto/KeyManager';
import useAppStore from '../store/appStore';
import QRCodeDisplay from '../components/common/QRCodeDisplay';
import type { AddContactScreenProps } from '../navigation/types';

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

type Tab = 'show' | 'scan';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const AddContactScreen: React.FC<AddContactScreenProps> = ({ navigation }) => {
  const { t } = useTranslation();
  const { displayName, publicKey } = useAppStore();

  const [activeTab, setActiveTab] = useState<Tab>('show');
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedContact, setScannedContact] = useState<{
    pubKey: Uint8Array;
    name: string;
  } | null>(null);

  const isProcessingRef = useRef(false);
  const slideAnim = useRef(new Animated.Value(0)).current;

  // -----------------------------------------------------------------------
  // Camera permission
  // -----------------------------------------------------------------------

  useEffect(() => {
    if (activeTab === 'scan') {
      requestCameraPermission();
    }
  }, [activeTab]);

  const requestCameraPermission = useCallback(async () => {
    const status = await Camera.requestCameraPermission();
    setHasPermission(status === 'granted');
  }, []);

  // -----------------------------------------------------------------------
  // QR code value
  // -----------------------------------------------------------------------

  const qrValue = React.useMemo(() => {
    if (!publicKey) {
      return '';
    }
    return `jisr://contact?pub=${publicKey}&name=${encodeURIComponent(displayName)}&v=1`;
  }, [publicKey, displayName]);

  // -----------------------------------------------------------------------
  // Tab switching
  // -----------------------------------------------------------------------

  const switchTab = useCallback(
    (tab: Tab) => {
      const toValue = tab === 'show' ? 0 : 1;
      Animated.spring(slideAnim, {
        toValue,
        useNativeDriver: false,
        friction: 8,
        tension: 60,
      }).start();
      setActiveTab(tab);
      setScannedContact(null);
      isProcessingRef.current = false;
    },
    [slideAnim],
  );

  // -----------------------------------------------------------------------
  // QR code scanning
  // -----------------------------------------------------------------------

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (isProcessingRef.current || codes.length === 0) {
        return;
      }

      const code = codes[0];
      if (!code.value) {
        return;
      }

      isProcessingRef.current = true;

      const parsed = keyManager.parseContactQR(code.value);

      if (!parsed) {
        Alert.alert(
          t('common.error'),
          t('add_contact.invalid_qr'),
          [
            {
              text: t('common.ok'),
              onPress: () => {
                isProcessingRef.current = false;
              },
            },
          ],
        );
        return;
      }

      setScannedContact(parsed);
    },
  });

  const device = useCameraDevice('back');

  // -----------------------------------------------------------------------
  // Contact confirmation
  // -----------------------------------------------------------------------

  const handleConfirmAdd = useCallback(() => {
    if (!scannedContact) {
      return;
    }

    // TODO: Store the contact in the database
    // - contacts table: id, ed25519_pubkey, display_name, trust_level, added_at
    // - Initiate Noise XX handshake with the contact

    Alert.alert(
      t('add_contact.contact_added'),
      scannedContact.name,
      [
        {
          text: t('common.ok'),
          onPress: () => {
            navigation.goBack();
          },
        },
      ],
    );
  }, [scannedContact, t, navigation]);

  const handleCancelAdd = useCallback(() => {
    setScannedContact(null);
    isProcessingRef.current = false;
  }, []);

  // -----------------------------------------------------------------------
  // Tab indicator position
  // -----------------------------------------------------------------------

  const indicatorLeft = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '50%'],
  });

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Tab bar */}
        <View style={styles.tabBar}>
          <Animated.View
            style={[styles.tabIndicator, { left: indicatorLeft }]}
          />
          <TouchableOpacity
            style={styles.tab}
            onPress={() => switchTab('show')}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === 'show' && styles.tabTextActive,
              ]}
            >
              {t('add_contact.show_qr')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.tab}
            onPress={() => switchTab('scan')}
            activeOpacity={0.7}
          >
            <Text
              style={[
                styles.tabText,
                activeTab === 'scan' && styles.tabTextActive,
              ]}
            >
              {t('add_contact.scan_qr')}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tab content */}
        <View style={styles.content}>
          {activeTab === 'show' && (
            <ShowQRTab qrValue={qrValue} displayName={displayName} />
          )}

          {activeTab === 'scan' && !scannedContact && (
            <ScanQRTab
              hasPermission={hasPermission}
              device={device}
              codeScanner={codeScanner}
              t={t}
              onRequestPermission={requestCameraPermission}
            />
          )}

          {activeTab === 'scan' && scannedContact && (
            <ContactConfirmation
              contactName={scannedContact.name}
              onConfirm={handleConfirmAdd}
              onCancel={handleCancelAdd}
              t={t}
            />
          )}
        </View>
      </View>
    </SafeAreaView>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const ShowQRTab: React.FC<{
  qrValue: string;
  displayName: string;
}> = ({ qrValue, displayName }) => (
  <View style={styles.qrContainer}>
    {qrValue ? (
      <>
        <QRCodeDisplay value={qrValue} size={240} />
        <Text style={styles.qrName}>{displayName}</Text>
        <Text style={styles.qrHint}>
          {'\uD83D\uDCF1'} Share this QR code to add contacts
        </Text>
      </>
    ) : (
      <Text style={styles.qrError}>No identity key available</Text>
    )}
  </View>
);

const ScanQRTab: React.FC<{
  hasPermission: boolean | null;
  device: ReturnType<typeof useCameraDevice>;
  codeScanner: ReturnType<typeof useCodeScanner>;
  t: (key: string) => string;
  onRequestPermission: () => void;
}> = ({ hasPermission, device, codeScanner, t, onRequestPermission }) => {
  if (hasPermission === null) {
    return (
      <View style={styles.cameraPlaceholder}>
        <Text style={styles.cameraPlaceholderText}>
          Requesting camera permission...
        </Text>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.cameraPlaceholder}>
        <Text style={styles.cameraPlaceholderText}>
          Camera permission is required to scan QR codes
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={onRequestPermission}
          activeOpacity={0.7}
        >
          <Text style={styles.permissionButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.cameraPlaceholder}>
        <Text style={styles.cameraPlaceholderText}>
          No camera device available
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.cameraContainer}>
      <Camera
        style={styles.camera}
        device={device}
        isActive={true}
        codeScanner={codeScanner}
      />
      <View style={styles.scanOverlay}>
        <View style={styles.scanFrame} />
      </View>
      <Text style={styles.scanInstruction}>
        {t('add_contact.scan_instruction')}
      </Text>
    </View>
  );
};

const ContactConfirmation: React.FC<{
  contactName: string;
  onConfirm: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}> = ({ contactName, onConfirm, onCancel, t }) => (
  <View style={styles.confirmContainer}>
    <Text style={styles.confirmIcon}>{'\u2705'}</Text>
    <Text style={styles.confirmTitle}>{t('add_contact.contact_added')}</Text>
    <Text style={styles.confirmName}>{contactName}</Text>
    <View style={styles.confirmButtons}>
      <TouchableOpacity
        style={styles.cancelButton}
        onPress={onCancel}
        activeOpacity={0.7}
      >
        <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.addButton}
        onPress={onConfirm}
        activeOpacity={0.7}
      >
        <Text style={styles.addButtonText}>{t('contacts.add_contact')}</Text>
      </TouchableOpacity>
    </View>
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
  container: {
    flex: 1,
  },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    padding: 2,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: '50%',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    zIndex: 1,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#8E8E93',
  },
  tabTextActive: {
    color: '#1C1C1E',
    fontWeight: '600',
  },
  // Content
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Show QR tab
  qrContainer: {
    alignItems: 'center',
    gap: 20,
  },
  qrName: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  qrHint: {
    fontSize: 14,
    color: '#8E8E93',
  },
  qrError: {
    fontSize: 16,
    color: '#FF3B30',
  },
  // Scan QR tab
  cameraContainer: {
    flex: 1,
    width: '100%',
    position: 'relative',
  },
  camera: {
    flex: 1,
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scanInstruction: {
    position: 'absolute',
    bottom: 60,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '500',
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  // Camera placeholder
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 16,
  },
  cameraPlaceholderText: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
  },
  permissionButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Contact confirmation
  confirmContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  confirmIcon: {
    fontSize: 56,
    marginBottom: 4,
  },
  confirmTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  confirmName: {
    fontSize: 18,
    color: '#3C3C43',
    marginBottom: 24,
  },
  confirmButtons: {
    flexDirection: 'row',
    gap: 16,
  },
  cancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#C6C6C8',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '500',
    color: '#8E8E93',
  },
  addButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  addButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});

export default AddContactScreen;
