/**
 * QRCodeDisplay.tsx - QR code renderer with Jisr branding.
 *
 * Wraps react-native-qrcode-svg to display a QR code with the Jisr
 * logo/text in the center for brand recognition.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface QRCodeDisplayProps {
  /** The string value to encode in the QR code. */
  value: string;
  /** Size of the QR code in pixels. Defaults to 220. */
  size?: number;
}

// ---------------------------------------------------------------------------
// Logo component rendered in the center of the QR code
// ---------------------------------------------------------------------------

const JisrLogo: React.FC = () => (
  <View style={styles.logoContainer}>
    <Text style={styles.logoText}>{'\u062C\u0633\u0631'}</Text>
  </View>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const QRCodeDisplay: React.FC<QRCodeDisplayProps> = ({
  value,
  size = 220,
}) => {
  return (
    <View style={styles.container}>
      <View style={styles.qrWrapper}>
        <QRCode
          value={value}
          size={size}
          color="#1C1C1E"
          backgroundColor="#FFFFFF"
          logo={undefined}
          logoSize={40}
          logoBackgroundColor="#FFFFFF"
          logoBorderRadius={8}
          ecl="M"
        />
        {/* Overlay the Jisr logo in the center */}
        <View style={[styles.logoOverlay, { top: (size - 36) / 2, left: (size - 44) / 2 }]}>
          <JisrLogo />
        </View>
      </View>
    </View>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrWrapper: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
    position: 'relative',
  },
  logoOverlay: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    width: 44,
    height: 36,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  logoText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#007AFF',
  },
});

export default QRCodeDisplay;
