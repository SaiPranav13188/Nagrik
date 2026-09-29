import React, { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EmptyState, Skeleton, Text } from '../../components/ui';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { radius, space, useTheme } from '../../theme';

function iconFor(title: string): { name: keyof typeof Ionicons.glyphMap; tone: 'success' | 'warning' | 'danger' | 'primary' } {
  const s = title.toLowerCase();
  if (/resolved|fixed|🎉/.test(s)) return { name: 'trophy', tone: 'success' };
  if (/filed|✅/.test(s)) return { name: 'checkmark-done', tone: 'primary' };
  if (/escalat/.test(s)) return { name: 'trending-up', tone: 'danger' };
  if (/step|details|ready|needs|finish/.test(s)) return { name: 'hand-left', tone: 'warning' };
  return { name: 'notifications', tone: 'primary' };
}

export default function Updates() {
  const { c } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const q = useApi(() => api.notifications());

  // Opening this tab marks everything as read (after it has been shown once).
  useFocusEffect(
    useCallback(() => {
      const id = setTimeout(() => api.markNotificationsRead().catch(() => {}), 1500);
      return () => clearTimeout(id);
    }, []),
  );

  const tones = { success: [c.success, c.successSoft], warning: [c.warning, c.warningSoft], danger: [c.danger, c.dangerSoft], primary: [c.primary, c.primarySoft] } as const;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: space(5), paddingVertical: space(4) }}>
        <Text variant="display">{t('updatesTitle')}</Text>
      </View>
      {q.loading && !q.data ? (
        <View style={{ paddingHorizontal: space(5), gap: space(3) }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={72} style={{ borderRadius: radius.lg }} />
          ))}
        </View>
      ) : (
        <FlatList
          data={q.data?.notifications ?? []}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(28), flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.refresh} tintColor={c.primary} colors={[c.primary]} />}
          ListEmptyComponent={<EmptyState icon="notifications-off-outline" title={t('noUpdates')} body={t('noUpdatesBody')} />}
          ItemSeparatorComponent={() => <View style={{ height: space(2) }} />}
          renderItem={({ item }) => {
            const ic = iconFor(item.title);
            const [fg, bg] = tones[ic.tone];
            return (
              <Pressable
                onPress={() => item.complaint_id && router.push(`/complaint/${item.complaint_id}`)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  gap: space(3),
                  padding: space(3.5),
                  borderRadius: radius.lg,
                  backgroundColor: item.read ? c.surface : c.primarySoft + '55',
                  borderWidth: 1,
                  borderColor: item.read ? c.line : c.primary + '44',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name={ic.name} size={19} color={fg} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space(2) }}>
                    <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>{item.title}</Text>
                    <Text variant="small" tone="faint">{relativeTime(item.created_at, t)}</Text>
                  </View>
                  <Text variant="small" tone="muted">{item.body}</Text>
                </View>
                {!item.read && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.primary, marginTop: 6 }} />}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
