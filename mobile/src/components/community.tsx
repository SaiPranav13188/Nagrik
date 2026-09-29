import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { radius, space, useTheme } from '../theme';
import { useI18n } from '../lib/i18n';
import { resolveMediaUrl } from '../lib/config';
import { issueMeta, relativeTime, shortAddress } from '../lib/format';
import type { NearbyItem } from '../lib/types';
import { StatusPill } from './complaint';
import { Button, Pill, Text } from './ui';

/** "N residents affected": the reporter plus everyone who tapped "Me too". */
export function ResidentsPill({ supporters, size = 'md' }: { supporters: number; size?: 'sm' | 'md' }) {
  const { c } = useTheme();
  const { t } = useI18n();
  if (!supporters) return null;
  return <Pill label={t('residentsAffected', { n: supporters + 1 })} icon="people" fg={c.info} bg={c.infoSoft} size={size} />;
}

export function formatDistance(m: number | null, t: ReturnType<typeof useI18n>['t']) {
  if (m == null) return null;
  return m < 1000 ? t('distanceM', { m: Math.max(5, Math.round(m / 5) * 5) }) : t('distanceKm', { km: (m / 1000).toFixed(1) });
}

/** Compact view of someone's report with the right community action. */
export function IssuePreview({
  item,
  busy,
  onSupport,
  onUnsupport,
  onOpen,
}: {
  item: NearbyItem;
  busy?: boolean;
  onSupport?: () => void;
  onUnsupport?: () => void;
  onOpen?: () => void;
}) {
  const { c } = useTheme();
  const { t } = useI18n();
  const meta = issueMeta(item.issue_type);
  const distance = formatDistance(item.distance_m, t);
  return (
    <View style={{ gap: space(3) }}>
      <View style={{ flexDirection: 'row', gap: space(3) }}>
        <Image source={resolveMediaUrl(item.photo_url) ?? undefined} style={{ width: 84, height: 84, borderRadius: radius.md, backgroundColor: c.surfaceAlt }} contentFit="cover" />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Ionicons name={meta.icon} size={16} color={meta.tint} />
            <Text variant="bodyStrong" style={{ flex: 1 }} numberOfLines={1}>{t(meta.key)}</Text>
          </View>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {[distance, shortAddress(item.address)].filter(Boolean).join(' · ')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
            <StatusPill complaint={{ status: item.status, submit_after: null }} size="sm" />
            <ResidentsPill supporters={item.supporters_count} size="sm" />
          </View>
          <Text variant="small" tone="faint" style={{ fontSize: 11 }}>{relativeTime(item.created_at, t)}</Text>
        </View>
      </View>
      {item.description ? (
        <Text variant="small" tone="soft" numberOfLines={3}>{item.description}</Text>
      ) : null}
      {item.is_mine ? (
        <Button title={`${t('yourReport')} · ${t('openIt')}`} variant="secondary" size="md" icon="open-outline" onPress={onOpen} />
      ) : item.supported_by_me ? (
        <View style={{ flexDirection: 'row', gap: space(2) }}>
          <Button title={t('openIt')} variant="secondary" size="md" icon="open-outline" style={{ flex: 1 }} onPress={onOpen} />
          <Button title={t('removeSupport')} variant="ghost" size="md" style={{ flex: 1 }} loading={busy} onPress={onUnsupport} />
        </View>
      ) : (
        <Button title={t('meToo')} icon="hand-right" size="md" loading={busy} onPress={onSupport} />
      )}
    </View>
  );
}
