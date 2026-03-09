/**
 * RTLText.tsx - Text component with automatic RTL/LTR detection.
 *
 * Inspects the text content for Arabic script characters and applies
 * the correct writingDirection style so that mixed-direction UIs
 * render correctly without manual per-instance configuration.
 */

import React from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Arabic script detection
// ---------------------------------------------------------------------------

/**
 * Regular expression matching Arabic Unicode block characters.
 * Covers Arabic (0600-06FF), Arabic Supplement (0750-077F),
 * Arabic Extended-A (08A0-08FF), and Arabic Presentation Forms.
 */
const ARABIC_REGEX = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Determine whether a string contains Arabic script and should be
 * rendered right-to-left.
 */
function containsArabic(text: string): boolean {
  return ARABIC_REGEX.test(text);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface RTLTextProps extends TextProps {
  children?: React.ReactNode;
}

/**
 * A drop-in replacement for React Native's Text that automatically
 * detects Arabic content and sets writingDirection accordingly.
 *
 * For non-string children (e.g. nested Text components), the component
 * falls back to the platform default direction.
 */
const RTLText: React.FC<RTLTextProps> = ({ children, style, ...rest }) => {
  const textContent = extractTextContent(children);
  const isRTL = textContent ? containsArabic(textContent) : false;

  const directionStyle: TextStyle = {
    writingDirection: isRTL ? 'rtl' : 'ltr',
    textAlign: isRTL ? 'right' : 'left',
  };

  return (
    <Text style={[directionStyle, style]} {...rest}>
      {children}
    </Text>
  );
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively extract string content from React children.
 * Returns the concatenated text or null if no string content is found.
 */
function extractTextContent(children: React.ReactNode): string | null {
  if (typeof children === 'string') {
    return children;
  }
  if (typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    const parts: string[] = [];
    for (const child of children) {
      const text = extractTextContent(child);
      if (text) {
        parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

export default RTLText;
