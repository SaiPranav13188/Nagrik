import React, { useEffect, useRef } from 'react';
import { Animated, Modal, Pressable, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useTheme } from '../theme';

/** Lightweight bottom sheet built on Modal — no extra native deps. */
export function Sheet({ visible, onClose, children, dismissable = true }: { visible: boolean; onClose: () => void; children: React.ReactNode; dismissable?: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, { toValue: visible ? 1 : 0, useNativeDriver: true, friction: 9, tension: 70 }).start();
  }, [visible, anim]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => dismissable && onClose()} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.overlay }} onPress={() => dismissable && onClose()} accessibilityLabel="Close" />
        <Animated.View
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.xl,
            borderTopRightRadius: radius.xl,
            paddingHorizontal: space(5),
            paddingTop: space(3),
            paddingBottom: insets.bottom + space(5),
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [400, 0] }) }],
          }}
        >
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: c.line, marginBottom: space(4) }} />
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
