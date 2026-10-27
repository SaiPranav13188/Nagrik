import React, { useEffect, useMemo } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, EmptyState, SectionTitle, Skeleton, Text } from '../../components/ui';
import { ComplaintCard } from '../../components/complaint';
import { api, errorMessage } from '../../lib/api';
import { onboardingFlags, useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { IN_PROGRESS, needsUser } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { pushSupported } from '../../lib/notifications';
import { BRAND_GRADIENT, radius, space, useTheme } from '../../theme';

export default function Home() {
  const { c, shadow } = useTheme();
  const { t } = useI18n();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();

  const list = useApi(() => api.complaints().then((r) => r.complaints));
  const notes = useApi(() => api.notifications(), { pollMs: 30000 });
  const health = useApi(() => api.health());
  const testMode = health.data?.portal_mode === 'sandbox';
  const complaints = useMemo(() => list.data ?? [], [list.data]);
  const live = complaints.some((x) => IN_PROGRESS.includes(x.status));

  // Poll quickly while agents are working on something.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void list.reload(), 3000);
    return () => clearInterval(id);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask for notification permission once, after the first complaint exists.
  useEffect(() => {
    if (!complaints.length || !pushSupported) return;
    onboardingFlags.notifAsked().then((asked) => {
      if (!asked) router.push('/notifications-setup');
    });
  }, [complaints.length]);

  const { attention, rest, stats } = useMemo(() => {
    const attention = complaints.filter(needsUser);
    const rest = complaints.filter((x) => !needsUser(x));
    return {
      attention,
      rest,
      stats: {
        active: complaints.filter((x) => ['analyzing', 'drafted', 'submitting', 'submitted', 'escalated'].includes(x.status) && !needsUser(x)).length,
        needs: attention.length,
        resolved: complaints.filter((x) => x.status === 'resolved').length,
      },
    };
  }, [complaints]);

  const firstName = profile?.full_name?.split(' ')[0];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ paddingBottom: space(28) }}
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} tintColor={c.primary} colors={[c.primary]} />}
    >
      <LinearGradient colors={BRAND_GRADIENT} style={{ paddingTop: insets.top + space(4), paddingHorizontal: space(5), paddingBottom: space(16), borderBottomLeftRadius: 32, borderBottomRightRadius: 32 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Text variant="small" color="rgba(255,255,255,0.8)">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
            <Text variant="title" color="#fff" numberOfLines={1}>
              {firstName ? t('greeting', { name: firstName }) : t('greetingAnon')} 👋
            </Text>
          </View>
          <Pressable onPress={() => router.navigate('/updates')} accessibilityLabel={t('tabUpdates')} hitSlop={8} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="notifications-outline" size={22} color="#fff" />
            {!!notes.data?.unread && (
              <View style={{ position: 'absolute', top: 8, right: 9, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}>
                <Text style={{ fontSize: 10, lineHeight: 12 }} variant="smallStrong" color="#1F1300">{Math.min(notes.data.unread, 9)}</Text>
              </View>
            )}
          </Pressable>
        </View>
        {/* Store listing and testers must not think complaints reach real offices while in sandbox mode. */}
        {testMode && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2), marginTop: space(3), paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.16)' }}>
            <Ionicons name="flask-outline" size={16} color="#fff" />
            <Text variant="small" color="#fff" style={{ flex: 1 }}>{t('testModeBanner')}</Text>
          </View>
        )}
      </LinearGradient>

      <View style={{ paddingHorizontal: space(5), marginTop: -space(12), gap: space(5) }}>
        <Card style={{ padding: space(5), gap: space(4), ...shadow(4) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(4) }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="title">{t('heroTitle')}</Text>
              <Text tone="muted">{t('heroBody')}</Text>
            </View>
            <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: c.accentSoft, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '8deg' }] }}>
              <Ionicons name="camera" size={30} color={c.accent} />
            </View>
          </View>
          <Button title={t('reportIssue')} icon="camera-outline" onPress={() => router.push('/report')} />
        </Card>

        {complaints.length > 0 && (
          <View style={{ flexDirection: 'row', gap: space(3) }}>
            {[
              { label: t('statActive'), value: stats.active, color: c.primary, icon: 'time-outline' as const },
              { label: t('statNeedsYou'), value: stats.needs, color: c.warning, icon: 'hand-left-outline' as const },
              { label: t('statResolved'), value: stats.resolved, color: c.success, icon: 'checkmark-circle-outline' as const },
            ].map((s) => (
              <View key={s.label} style={{ flex: 1, backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.line, padding: space(3.5), gap: 4 }}>
                <Ionicons name={s.icon} size={18} color={s.color} />
                <Text variant="title" style={{ fontSize: 24 }}>{s.value}</Text>
                <Text variant="small" tone="muted" numberOfLines={1}>{s.label}</Text>
              </View>
            ))}
          </View>
        )}

        {list.loading && !list.data ? (
          <View style={{ gap: space(3) }}>
            {[0, 1, 2].map((i) => (
              <Card key={i} style={{ flexDirection: 'row', gap: space(3) }}>
                <Skeleton width={76} height={76} />
                <View style={{ flex: 1, gap: space(2) }}>
                  <Skeleton width="60%" />
                  <Skeleton width="85%" height={12} />
                  <Skeleton width={90} height={20} />
                </View>
              </Card>
            ))}
          </View>
        ) : list.error && !list.data ? (
          <Card style={{ alignItems: 'center', gap: space(3) }}>
            <Ionicons name="cloud-offline-outline" size={32} color={c.muted} />
            <Text tone="muted" style={{ textAlign: 'center' }}>{errorMessage(list.error, t('offline'), t('somethingWrong'))}</Text>
            <Button title={t('retry')} variant="secondary" size="md" onPress={list.refresh} />
          </Card>
        ) : complaints.length === 0 ? (
          <EmptyState icon="leaf-outline" title={t('emptyTitle')} body={t('emptyBody')}>
            <View style={{ flexDirection: 'row', gap: space(2), backgroundColor: c.accentSoft, padding: space(3), borderRadius: radius.md, marginTop: space(3) }}>
              <Ionicons name="bulb-outline" size={18} color={c.warning} />
              <Text variant="small" tone="soft" style={{ flex: 1 }}>{t('emptyTip')}</Text>
            </View>
          </EmptyState>
        ) : (
          <>
            {attention.length > 0 && (
              <View>
                <SectionTitle title={`${t('needsAttention')} (${attention.length})`} />
                {attention.map((x) => (
                  <ComplaintCard key={x.id} complaint={x} />
                ))}
              </View>
            )}
            {rest.length > 0 && (
              <View>
                <SectionTitle title={t('yourComplaints')} />
                {rest.map((x) => (
                  <ComplaintCard key={x.id} complaint={x} />
                ))}
              </View>
            )}
          </>
        )}
      </View>
    </ScrollView>
  );
}
