import React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { radius, space, useTheme } from '../theme';
import { useI18n, type TKey } from '../lib/i18n';
import { resolveMediaUrl } from '../lib/config';
import { displayStatus, formatDateTime, issueMeta, relativeTime, shortAddress, statusStyle } from '../lib/format';
import type { ActivityItem, Complaint } from '../lib/types';
import { Card, Pill, PulseDot, Text } from './ui';

export function StatusPill({ complaint, size }: { complaint: Pick<Complaint, 'status' | 'submit_after'>; size?: 'sm' | 'md' }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const s = displayStatus(complaint);
  const st = statusStyle(s, c);
  return <Pill label={t(`status_${s}` as TKey)} fg={st.fg} bg={st.bg} icon={st.icon} size={size} />;
}

export function ComplaintCard({ complaint }: { complaint: Complaint }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const meta = issueMeta(complaint.issue_type);
  const live = ['analyzing', 'submitting'].includes(complaint.status) || displayStatus(complaint) === 'filing_soon';
  return (
    <Card padded={false} onPress={() => router.push(`/complaint/${complaint.id}`)} style={{ marginBottom: space(3) }}>
      <View style={{ flexDirection: 'row', padding: space(3), gap: space(3) }}>
        <View>
          <Image
            source={resolveMediaUrl(complaint.photo_url) ?? undefined}
            style={{ width: 76, height: 76, borderRadius: radius.md, backgroundColor: c.surfaceAlt }}
            contentFit="cover"
            transition={200}
            accessibilityIgnoresInvertColors
          />
          <View style={{ position: 'absolute', bottom: -6, right: -6, backgroundColor: c.surface, borderRadius: 14, padding: 3 }}>
            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: meta.tint, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={meta.icon} size={13} color="#fff" />
            </View>
          </View>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space(2) }}>
            <Text variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
              {t(meta.key)}
            </Text>
            <Text variant="small" tone="faint">{relativeTime(complaint.created_at, t)}</Text>
          </View>
          <Text variant="small" tone="muted" numberOfLines={1}>
            {shortAddress(complaint.address) || '—'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(1), marginTop: 4 }}>
            <StatusPill complaint={complaint} size="sm" />
            {live && <PulseDot color={c.primary} size={6} />}
            {complaint.tracking_id && (
              <Text variant="small" tone="faint" numberOfLines={1} style={{ flex: 1, marginLeft: 4 }}>
                #{complaint.tracking_id}
              </Text>
            )}
          </View>
        </View>
      </View>
    </Card>
  );
}

// ───────────────────────── progress tracker ─────────────────────────
const STEPS: TKey[] = ['stepReported', 'stepRouted', 'stepDrafted', 'stepFiled', 'stepResolved'];

export function progressIndex(cmp: Complaint) {
  switch (cmp.status) {
    case 'analyzing':
      return cmp.jurisdiction_portal_id ? 1 : 0;
    case 'drafted':
    case 'submitting':
    case 'submission_failed':
      return cmp.draft_text ? 2 : cmp.jurisdiction_portal_id ? 1 : 0;
    case 'submitted':
    case 'escalated':
      return 3;
    case 'resolved':
      return 4;
  }
}

export function ProgressTracker({ complaint }: { complaint: Complaint }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const idx = progressIndex(complaint);
  const working = ['analyzing', 'submitting'].includes(complaint.status);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 4, now: idx }}>
      {STEPS.map((k, i) => {
        const done = i <= idx;
        const current = i === idx + 1 && working;
        return (
          <React.Fragment key={k}>
            <View style={{ alignItems: 'center', width: 58 }}>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: done ? (i === 4 ? c.success : c.primary) : c.surfaceAlt,
                  borderWidth: current ? 2 : 0,
                  borderColor: c.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {done ? <Ionicons name="checkmark" size={15} color="#fff" /> : current ? <PulseDot color={c.primary} size={5} /> : <Text variant="small" tone="faint" style={{ fontSize: 11 }}>{i + 1}</Text>}
              </View>
              <Text variant="small" tone={done ? undefined : 'faint'} style={{ fontSize: 11, marginTop: 6, textAlign: 'center' }} numberOfLines={1}>
                {t(k)}
              </Text>
            </View>
            {i < STEPS.length - 1 && <View style={{ flex: 1, height: 3, borderRadius: 2, marginTop: 11.5, marginHorizontal: -12, backgroundColor: i < idx ? c.primary : c.surfaceAlt }} />}
          </React.Fragment>
        );
      })}
    </View>
  );
}

// ───────────────────────── agent activity timeline ─────────────────────────
type Glyph = keyof typeof Ionicons.glyphMap;
function glyph(name: string): Glyph {
  const map = Ionicons.glyphMap as Record<string, number>;
  if (map[`${name}-outline`]) return `${name}-outline` as Glyph;
  if (map[name]) return name as Glyph;
  return 'ellipse-outline';
}

export function ActivityTimeline({ items, live }: { items: ActivityItem[]; live?: boolean }) {
  const { c } = useTheme();
  const toneColor = (tone: ActivityItem['tone']) => (tone === 'success' ? c.success : tone === 'warning' ? c.warning : tone === 'error' ? c.danger : c.primary);
  return (
    <View>
      {items.map((it, i) => {
        const last = i === items.length - 1;
        const col = toneColor(it.tone);
        return (
          <View key={it.id} style={{ flexDirection: 'row', gap: space(3) }}>
            <View style={{ alignItems: 'center' }}>
              <View style={{ width: 30, height: 30, borderRadius: 10, backgroundColor: col + '22', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={glyph(it.icon)} size={16} color={col} />
              </View>
              {(!last || live) && <View style={{ width: 2, flex: 1, minHeight: 14, backgroundColor: c.line, marginVertical: 2 }} />}
            </View>
            <View style={{ flex: 1, paddingBottom: space(3.5) }}>
              <Text variant="smallStrong">{it.title}</Text>
              {it.detail ? (
                <Text variant="small" tone="muted" numberOfLines={3}>
                  {it.detail}
                </Text>
              ) : null}
              <Text variant="small" tone="faint" style={{ fontSize: 11, marginTop: 2 }}>
                {it.agent} agent · {formatDateTime(it.at)}
              </Text>
            </View>
          </View>
        );
      })}
      {live && (
        <View style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}>
          <View style={{ width: 30, alignItems: 'center' }}>
            <PulseDot color={c.primary} size={7} />
          </View>
          <Text variant="small" tone="muted">Working…</Text>
        </View>
      )}
    </View>
  );
}
