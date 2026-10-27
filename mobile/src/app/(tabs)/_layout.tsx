import React from 'react';
import { Pressable, View } from 'react-native';
import { Tabs, router } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useI18n, type TKey } from '../../lib/i18n';
import { space, useTheme } from '../../theme';

const TABS: Record<string, { icon: keyof typeof Ionicons.glyphMap; active: keyof typeof Ionicons.glyphMap; label: TKey }> = {
  index: { icon: 'home-outline', active: 'home', label: 'tabHome' },
  nearby: { icon: 'map-outline', active: 'map', label: 'tabNearby' },
  updates: { icon: 'notifications-outline', active: 'notifications', label: 'tabUpdates' },
  profile: { icon: 'person-circle-outline', active: 'person-circle', label: 'tabProfile' },
};

type BottomTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

function TabBar({ state, navigation }: BottomTabBarProps) {
  const { c, shadow } = useTheme();
  const { t } = useI18n();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const routes = state.routes.filter((r) => TABS[r.name]);
  const renderTab = (route: (typeof state.routes)[number]) => {
    const focused = state.routes[state.index]?.key === route.key;
    const meta = TABS[route.name];
    return (
      <Pressable
        key={route.key}
        accessibilityRole="tab"
        accessibilityState={{ selected: focused }}
        accessibilityLabel={t(meta.label)}
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          if (!focused) navigation.navigate(route.name);
        }}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: space(2) }}
      >
        {route.name === 'profile' && profile?.avatar_url ? (
          // The citizen's own photo, ringed in the accent colour when the tab is active.
          <Image
            source={{ uri: profile.avatar_url }}
            style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: focused ? c.primary : 'transparent' }}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Ionicons name={focused ? meta.active : meta.icon} size={24} color={focused ? c.primary : c.muted} />
        )}
        <Text variant="small" color={focused ? c.primary : c.muted} style={{ fontSize: 11 }}>{t(meta.label)}</Text>
      </Pressable>
    );
  };
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.line, paddingBottom: insets.bottom, paddingHorizontal: space(2), ...shadow(8) }}>
      {routes.slice(0, 2).map(renderTab)}
      <View style={{ flex: 1, alignItems: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('reportIssue')}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            router.push('/report');
          }}
          style={({ pressed }) => ({
            marginTop: -space(6),
            width: 62,
            height: 62,
            borderRadius: 22,
            backgroundColor: c.primary,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 4,
            borderColor: c.surface,
            transform: [{ scale: pressed ? 0.94 : 1 }],
            ...shadow(6),
          })}
        >
          <Ionicons name="camera" size={28} color={c.primaryInk} />
        </Pressable>
        <Text variant="smallStrong" color={c.primary} style={{ fontSize: 11, marginTop: 2 }}>{t('tabReport')}</Text>
      </View>
      {routes.slice(2).map(renderTab)}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <TabBar {...p} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="nearby" />
      <Tabs.Screen name="updates" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
