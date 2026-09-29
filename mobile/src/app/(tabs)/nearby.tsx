import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View, useWindowDimensions } from 'react-native';
import * as Location from 'expo-location';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, EmptyState, Skeleton, Text } from '../../components/ui';
import { StatusPill } from '../../components/complaint';
import { IssuePreview, ResidentsPill, formatDistance } from '../../components/community';
import { NearbyMap } from '../../components/NearbyMap';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/config';
import { issueMeta } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { NearbyItem } from '../../lib/types';
import { radius, space, useTheme } from '../../theme';

const RADIUS_M = 3000;

export default function Nearby() {
  const { c } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locError, setLocError] = useState(false);
  const [items, setItems] = useState<NearbyItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<NearbyItem | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (at: { latitude: number; longitude: number }) => {
    try {
      const r = await api.nearby(at.latitude, at.longitude, RADIUS_M);
      setItems(r.items);
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
      setItems((prev) => prev ?? []);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const locate = useCallback(async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return setLocError(true);
      const quick = await Location.getLastKnownPositionAsync();
      if (quick) setCenter({ latitude: quick.coords.latitude, longitude: quick.coords.longitude });
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const at = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setCenter(at);
      setLocError(false);
      await load(at);
    } catch {
      setLocError(true);
    }
  }, [load]);

  useEffect(() => {
    void locate();
  }, [locate]);

  const refresh = async () => {
    if (!center) return locate();
    setRefreshing(true);
    await load(center);
    setRefreshing(false);
  };

  const update = (id: string, patch: Partial<NearbyItem>) => {
    setItems((list) => list?.map((i) => (i.id === id ? { ...i, ...patch } : i)) ?? null);
    setSelected((s) => (s && s.id === id ? { ...s, ...patch } : s));
  };

  const support = async (item: NearbyItem) => {
    setBusy(true);
    try {
      const r = await api.support(item.id);
      update(item.id, { supported_by_me: true, supporters_count: r.supporters_count });
      toast(t('supportAdded'), 'success');
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const unsupport = async (item: NearbyItem) => {
    setBusy(true);
    try {
      const r = await api.unsupport(item.id);
      update(item.id, { supported_by_me: false, supporters_count: r.supporters_count });
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const mapHeight = Math.round(height * 0.38);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: space(5), paddingVertical: space(3), flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text variant="title">{t('nearbyTitle')}</Text>
          <Text variant="small" tone="muted">
            {t('nearbySubtitle', { km: RADIUS_M / 1000 })}
            {items ? ` · ${items.length}` : ''}
          </Text>
        </View>
        <Pressable onPress={locate} hitSlop={10} accessibilityLabel={t('useGps')} style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="locate" size={20} color={c.primary} />
        </Pressable>
      </View>

      {locError && !center ? (
        <EmptyState icon="location-outline" title={t('nearbyTitle')} body={t('nearbyNeedLocation')}>
          <Button title={t('useGps')} icon="locate" size="md" onPress={locate} style={{ marginTop: space(3) }} />
        </EmptyState>
      ) : (
        <FlatList
          data={items ?? []}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.primary} colors={[c.primary]} />}
          contentContainerStyle={{ paddingBottom: space(28) }}
          ListHeaderComponent={
            center ? (
              <View style={{ marginHorizontal: space(4), marginBottom: space(4), borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
                <NearbyMap
                  center={center}
                  items={items ?? []}
                  height={mapHeight}
                  onSelect={(id) => setSelected((items ?? []).find((i) => i.id === id) ?? null)}
                />
              </View>
            ) : (
              <Skeleton height={mapHeight} style={{ marginHorizontal: space(4), marginBottom: space(4), width: undefined, borderRadius: radius.lg }} />
            )
          }
          ListEmptyComponent={
            items === null ? (
              <View style={{ paddingHorizontal: space(4), gap: space(3) }}>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} height={76} style={{ borderRadius: radius.lg }} />
                ))}
              </View>
            ) : (
              <EmptyState icon="happy-outline" title={t('nearbyEmpty')} body={t('nearbyEmptyBody')}>
                <Button title={t('reportIssue')} icon="camera-outline" size="md" onPress={() => router.push('/report')} style={{ marginTop: space(3) }} />
              </EmptyState>
            )
          }
          ItemSeparatorComponent={() => <View style={{ height: space(2) }} />}
          renderItem={({ item }) => {
            const meta = issueMeta(item.issue_type);
            return (
              <Pressable
                onPress={() => setSelected(item)}
                style={({ pressed }) => ({
                  marginHorizontal: space(4),
                  flexDirection: 'row',
                  gap: space(3),
                  padding: space(3),
                  borderRadius: radius.lg,
                  backgroundColor: c.surface,
                  borderWidth: 1,
                  borderColor: c.line,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Image source={resolveMediaUrl(item.photo_url) ?? undefined} style={{ width: 56, height: 56, borderRadius: radius.sm, backgroundColor: c.surfaceAlt }} contentFit="cover" />
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name={meta.icon} size={15} color={meta.tint} />
                    <Text variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>{t(meta.key)}</Text>
                    <Text variant="small" tone="faint">{formatDistance(item.distance_m, t)}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <StatusPill complaint={{ status: item.status, submit_after: null }} size="sm" />
                    <ResidentsPill supporters={item.supporters_count} size="sm" />
                    {item.is_mine && <Text variant="small" tone="primary">· {t('yourReport')}</Text>}
                    {item.supported_by_me && <Text variant="small" tone="primary">· {t('meTooDone')}</Text>}
                  </View>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <Sheet visible={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <IssuePreview
            item={selected}
            busy={busy}
            onSupport={() => support(selected)}
            onUnsupport={() => unsupport(selected)}
            onOpen={() => {
              const id = selected.id;
              setSelected(null);
              router.push(`/complaint/${id}`);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
