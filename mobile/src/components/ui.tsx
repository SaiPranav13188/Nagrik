import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  Text as RNText,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { font, radius, space, useTheme } from '../theme';

type IconName = keyof typeof Ionicons.glyphMap;

// ───────────────────────────── Text ─────────────────────────────
const VARIANTS = {
  display: { fontFamily: font.extrabold, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  title: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  heading: { fontFamily: font.semibold, fontSize: 17, lineHeight: 23, letterSpacing: -0.1 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: font.semibold, fontSize: 15, lineHeight: 22 },
  small: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  smallStrong: { fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.medium, fontSize: 11, lineHeight: 14, letterSpacing: 0.6, textTransform: 'uppercase' as const },
} satisfies Record<string, TextStyle>;

export function Text({
  variant = 'body',
  color,
  tone,
  style,
  ...rest
}: TextProps & { variant?: keyof typeof VARIANTS; color?: string; tone?: 'muted' | 'soft' | 'faint' | 'primary' }) {
  const { c } = useTheme();
  const toneColor = tone === 'muted' ? c.muted : tone === 'soft' ? c.inkSoft : tone === 'faint' ? c.faint : tone === 'primary' ? c.primary : c.ink;
  return <RNText {...rest} style={[VARIANTS[variant], { color: color ?? toneColor }, style]} />;
}

// ───────────────────────────── Button ─────────────────────────────
export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  iconPosition = 'left',
  loading,
  disabled,
  size = 'lg',
  style,
  haptic = true,
  ...rest
}: Omit<PressableProps, 'style'> & {
  title: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  icon?: IconName;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  size?: 'lg' | 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  haptic?: boolean;
}) {
  const { c } = useTheme();
  const scheme = {
    primary: { bg: c.primary, fg: c.primaryInk, border: c.primary },
    secondary: { bg: c.surface, fg: c.ink, border: c.line },
    ghost: { bg: 'transparent', fg: c.primary, border: 'transparent' },
    danger: { bg: c.dangerSoft, fg: c.danger, border: c.dangerSoft },
    accent: { bg: c.accent, fg: '#1F1300', border: c.accent },
  }[variant];
  const h = size === 'lg' ? 54 : size === 'md' ? 46 : 36;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      onPress={(e) => {
        if (haptic) Haptics.selectionAsync().catch(() => {});
        onPress?.(e);
      }}
      style={({ pressed }) => [
        {
          height: h,
          paddingHorizontal: size === 'sm' ? space(3) : space(5),
          borderRadius: size === 'sm' ? radius.sm : radius.md,
          backgroundColor: scheme.bg,
          borderWidth: 1,
          borderColor: scheme.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: space(2),
          opacity: off ? 0.55 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={scheme.fg} />
      ) : (
        <>
          {icon && iconPosition === 'left' && <Ionicons name={icon} size={size === 'sm' ? 16 : 20} color={scheme.fg} />}
          <Text variant={size === 'sm' ? 'smallStrong' : 'bodyStrong'} color={scheme.fg} numberOfLines={1}>
            {title}
          </Text>
          {icon && iconPosition === 'right' && <Ionicons name={icon} size={size === 'sm' ? 16 : 20} color={scheme.fg} />}
        </>
      )}
    </Pressable>
  );
}

// ───────────────────────────── Card ─────────────────────────────
export function Card({ children, style, padded = true, onPress }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; onPress?: () => void }) {
  const { c, shadow } = useTheme();
  const base: ViewStyle = { backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.line, padding: padded ? space(4) : 0, ...shadow(1) };
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [base, { opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] }, style]}>
        {children}
      </Pressable>
    );
  return <View style={[base, style]}>{children}</View>;
}

// ───────────────────────────── Pill / Badge ─────────────────────────────
export function Pill({ label, fg, bg, icon, size = 'md' }: { label: string; fg: string; bg: string; icon?: IconName; size?: 'md' | 'sm' }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: bg, paddingHorizontal: size === 'sm' ? 8 : 10, paddingVertical: size === 'sm' ? 3 : 5, borderRadius: radius.pill, alignSelf: 'flex-start' }}>
      {icon && <Ionicons name={icon} size={size === 'sm' ? 11 : 13} color={fg} />}
      <Text variant="smallStrong" color={fg} style={size === 'sm' ? { fontSize: 11, lineHeight: 14 } : undefined}>
        {label}
      </Text>
    </View>
  );
}

export function IconBubble({ name, color, bg, size = 40 }: { name: IconName; color: string; bg: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2.6, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={name} size={size * 0.5} color={color} />
    </View>
  );
}

// ───────────────────────────── Input ─────────────────────────────
export function Input({ label, error, hint, icon, style, ...rest }: TextInputProps & { label?: string; error?: string | null; hint?: string; icon?: IconName }) {
  const { c } = useTheme();
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label && <Text variant="smallStrong" tone="soft">{label}</Text>}
      <View
        style={{
          flexDirection: 'row',
          alignItems: rest.multiline ? 'flex-start' : 'center',
          gap: space(2),
          backgroundColor: c.surface,
          borderWidth: 1.5,
          borderColor: error ? c.danger : focused ? c.primary : c.line,
          borderRadius: radius.md,
          paddingHorizontal: space(3.5),
          minHeight: 52,
          paddingVertical: rest.multiline ? space(3) : 0,
        }}
      >
        {icon && <Ionicons name={icon} size={18} color={focused ? c.primary : c.muted} style={rest.multiline ? { marginTop: 2 } : undefined} />}
        <TextInput
          placeholderTextColor={c.faint}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          style={[{ flex: 1, color: c.ink, fontFamily: font.regular, fontSize: 16, paddingVertical: rest.multiline ? 0 : 12, textAlignVertical: rest.multiline ? 'top' : 'center' }, Platform.OS === 'web' ? ({ outlineStyle: 'none' } as unknown as TextStyle) : null, style]}
          {...rest}
        />
      </View>
      {error ? (
        <Text variant="small" color={c.danger}>{error}</Text>
      ) : hint ? (
        <Text variant="small" tone="muted">{hint}</Text>
      ) : null}
    </View>
  );
}

// ───────────────────────────── Misc ─────────────────────────────
export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return <View style={[{ height: 1, backgroundColor: c.line }, style]} />;
}

export function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space(3) }}>
      <Text variant="heading">{title}</Text>
      {action && (
        <Pressable onPress={onAction} hitSlop={10}>
          <Text variant="smallStrong" tone="primary">{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: number | `${number}%`; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const v = useState(() => new Animated.Value(0.5))[0];
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }), Animated.timing(v, { toValue: 0.5, duration: 700, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={[{ height, width, borderRadius: 8, backgroundColor: c.surfaceAlt, opacity: v }, style]} />;
}

export function EmptyState({ icon, title, body, children }: { icon: IconName; title: string; body: string; children?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space(10), paddingHorizontal: space(6), gap: space(3) }}>
      <View style={{ width: 88, height: 88, borderRadius: 30, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-6deg' }] }}>
        <Ionicons name={icon} size={40} color={c.primary} />
      </View>
      <Text variant="title" style={{ textAlign: 'center', marginTop: space(2) }}>{title}</Text>
      <Text tone="muted" style={{ textAlign: 'center' }}>{body}</Text>
      {children}
    </View>
  );
}

export function PulseDot({ color, size = 10 }: { color: string; size?: number }) {
  const v = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1400, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <View style={{ width: size * 2.4, height: size * 2.4, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={{
          position: 'absolute',
          width: size * 2.4,
          height: size * 2.4,
          borderRadius: size * 1.2,
          backgroundColor: color,
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
        }}
      />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
    </View>
  );
}
