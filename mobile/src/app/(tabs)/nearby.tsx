import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from 'react-native';
import * as Location from 'expo-location';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, EmptyState, Skeleton, Text } from '../../components/ui';
import { StatusPill } from '../../components/complaint';
import { IssuePreview, ResidentsPill, formatDistance } from '../../components/community';
import { NearbyMap, type NearbyMapHandle } from '../../components/NearbyMap';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/config';
import { issueMeta, statusStyle } from '../../lib/format';
import { useI18n, type TKey } from '../../lib/i18n';
import type { IssueType, NearbyItem } from '../../lib/types';
import { radius, space, useTheme } from '../../theme';

const RADIUS_M = 3000;

export default function Nearby() {
  const { c } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [center, setCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locError, setLocError] = useState(false);
  const [items, setItems] = useState<NearbyItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<NearbyItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [filter, setFilter] = useState<IssueType | null>(null);
  const mapRef = useRef<NearbyMapHandle>(null);

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

  // Filters apply to both views; types only appear once something of that type is nearby.
  const types = useMemo(() => {
    const counts = new Map<IssueType, number>();
    for (const i of items ?? []) counts.set(i.issue_type ?? 'other', (counts.get(i.issue_type ?? 'other') ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = useMemo(() => (items ?? []).filter((i) => !filter || (i.issue_type ?? 'other') === filter), [items, filter]);
  const statuses = useMemo(() => [...new Set(shown.map((i) => i.status))], [shown]);

  const chip = (key: string, label: string, active: boolean, onPress: () => void, icon?: React.ComponentProps<typeof Ionicons>['name'], tint?: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space(3), height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: active ? c.primary : c.line, backgroundColor: active ? c.primarySoft : c.surface }}
    >
      {icon && <Ionicons name={icon} size={14} color={active ? c.primary : tint ?? c.muted} />}
      <Text variant="smallStrong" color={active ? c.primary : c.inkSoft}>{label}</Text>
    </Pressable>
  );

  const mapButton = (icon: React.ComponentProps<typeof Ionicons>['name'], label: string, onPress: () => void) => (
    <Pressable onPress={onPress} hitSlop={6} accessibilityLabel={label} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', elevation: 3, shadowColor: c.shadow, shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
      <Ionicons name={icon} size={20} color={c.ink} />
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
      <View style={{ paddingHorizontal: space(5), paddingTop: space(3), paddingBottom: space(2), flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
        <View style={{ flex: 1 }}>
          <Text variant="title">{t('nearbyTitle')}</Text>
          <Text variant="small" tone="muted">
            {t('nearbySubtitle', { km: RADIUS_M / 1000 })}
            {items ? ` · ${t('nearbyCount', { n: items.length })}` : ''}
          </Text>
        </View>
        {/* Map / List switch */}
        <View style={{ flexDirection: 'row', backgroundColor: c.surfaceAlt, borderRadius: 12, padding: 3 }}>
          {(['map', 'list'] as const).map((v) => (
            <Pressable
              key={v}
              onPress={() => setView(v)}
              accessibilityLabel={t(v === 'map' ? 'viewMap' : 'viewList')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space(3), height: 34, borderRadius: 10, backgroundColor: view === v ? c.surface : 'transparent' }}
            >
              <Ionicons name={v === 'map' ? 'map' : 'list'} size={15} color={view === v ? c.primary : c.muted} />
              <Text variant="smallStrong" color={view === v ? c.primary : c.muted}>{t(v === 'map' ? 'viewMap' : 'viewList')}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {types.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space(4), paddingBottom: space(3), gap: space(2) }}>
          {chip('all', `${t('filterAll')} · ${items?.length ?? 0}`, !filter, () => setFilter(null))}
          {types.map(([type, n]) => {
            const meta = issueMeta(type);
            return chip(type, `${t(meta.key)} · ${n}`, filter === type, () => setFilter(filter === type ? null : type), meta.icon, meta.tint);
          })}
        </ScrollView>
      )}

      {locError && !center ? (
        <EmptyState icon="location-outline" title={t('nearbyTitle')} body={t('nearbyNeedLocation')}>
          <Button title={t('useGps')} icon="locate" size="md" onPress={locate} style={{ marginTop: space(3) }} />
        </EmptyState>
      ) : view === 'map' ? (
        center ? (
          <View style={{ flex: 1 }}>
            <NearbyMap
              ref={mapRef}
              center={center}
              radiusM={RADIUS_M}
              items={shown}
              selectedId={selected?.id ?? null}
              onSelect={(id) => setSelected((items ?? []).find((i) => i.id === id) ?? null)}
            />
            {/* Controls float on the map; the map itself gets every drag, so panning never scrolls the page. */}
            <View style={{ position: 'absolute', right: space(4), top: space(3), gap: space(2) }}>
              {mapButton('locate', t('centerOnMe'), () => mapRef.current?.recenter())}
              {mapButton('add', t('zoomIn'), () => mapRef.current?.zoom(1))}
              {mapButton('remove', t('zoomOut'), () => mapRef.current?.zoom(-1))}
              {mapButton('refresh', t('refresh'), () => void refresh())}
            </View>
            {statuses.length > 0 && (
              <View style={{ position: 'absolute', left: space(4), bottom: space(4) + insets.bottom + 64, flexDirection: 'row', flexWrap: 'wrap', gap: space(2), maxWidth: width - space(24), backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.line, paddingHorizontal: space(3), paddingVertical: space(2) }}>
                {statuses.map((s) => (
                  <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusStyle(s, c).fg }} />
                    <Text variant="small" style={{ fontSize: 11 }}>{t(`status_${s}` as TKey)}</Text>
                  </View>
                ))}
              </View>
            )}
            {items !== null && shown.length === 0 && (
              <View style={{ position: 'absolute', left: space(4), right: space(16), top: space(3), backgroundColor: c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: c.line, padding: space(3) }}>
                <Text variant="smallStrong">{t('nearbyEmpty')}</Text>
                <Text variant="small" tone="muted">{t('nearbyEmptyBody')}</Text>
              </View>
            )}
          </View>
        ) : (
          <Skeleton height={height * 0.6} style={{ marginHorizontal: space(4), width: undefined, borderRadius: radius.lg }} />
        )
      ) : (
        <FlatList
          data={items === null ? [] : shown}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.primary} colors={[c.primary]} />}
          contentContainerStyle={{ paddingBottom: space(28) }}
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
