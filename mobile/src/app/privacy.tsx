import React from 'react';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Divider, Text } from '../components/ui';
import { useToast } from '../components/Toast';
import { SUPPORT_EMAIL } from '../lib/config';
import { useI18n } from '../lib/i18n';
import { PRIVACY_INTRO, PRIVACY_SECTIONS, PRIVACY_UPDATED, type PolicyBlock } from '../lib/privacyPolicy';
import { space, useTheme } from '../theme';

/** The full privacy policy, inside the app (no browser). */
export default function Privacy() {
  const { c } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const emailUs = async () => {
    try {
      await Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Nagrik privacy')}`);
    } catch {
      toast(t('noEmailApp', { email: SUPPORT_EMAIL }), 'error');
    }
  };

  const block = (b: PolicyBlock, i: number) => {
    if (b.kind === 'p') return <Text key={i} tone="soft">{b.text}</Text>;
    if (b.kind === 'list') {
      return (
        <View key={i} style={{ gap: space(2) }}>
          {b.items.map((item, j) => (
            <View key={j} style={{ flexDirection: 'row', gap: space(2) }}>
              <Text tone="muted">•</Text>
              <Text tone="soft" style={{ flex: 1 }}>{item}</Text>
            </View>
          ))}
        </View>
      );
    }
    return (
      <Card key={i} style={{ paddingVertical: space(1) }}>
        {b.rows.map(([what, why], j) => (
          <View key={j}>
            {j > 0 && <Divider />}
            <View style={{ paddingVertical: space(3), gap: 2 }}>
              <Text variant="bodyStrong">{what}</Text>
              <Text variant="small" tone="muted">{why}</Text>
            </View>
          </View>
        ))}
      </Card>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingTop: insets.top + space(2), paddingHorizontal: space(4), paddingBottom: space(2) }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('back')} style={{ width: 40, height: 40, justifyContent: 'center' }}>
          <Ionicons name="arrow-back" size={24} color={c.ink} />
        </Pressable>
        <Text variant="title" style={{ flex: 1 }}>{t('privacyPolicy')}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: insets.bottom + space(8) }}>
        <Text variant="small" tone="faint">Last updated {PRIVACY_UPDATED}</Text>
        <Text tone="soft">{PRIVACY_INTRO}</Text>
        {PRIVACY_SECTIONS.map((s) => (
          <View key={s.title} style={{ gap: space(3) }}>
            <Text variant="heading">{s.title}</Text>
            {s.blocks.map(block)}
          </View>
        ))}
        <Button title={t('emailSupport')} variant="secondary" icon="mail-outline" onPress={emailUs} />
      </ScrollView>
    </View>
  );
}
