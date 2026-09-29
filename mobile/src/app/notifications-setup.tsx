import React, { useState } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Text } from '../components/ui';
import { onboardingFlags } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { enableNotifications } from '../lib/notifications';
import { space, useTheme } from '../theme';

export default function NotificationsSetup() {
  const { c } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);

  const finish = async (enable: boolean) => {
    setBusy(true);
    if (enable) await enableNotifications();
    await onboardingFlags.setNotifAsked();
    setBusy(false);
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: space(6), paddingTop: insets.top + space(16), paddingBottom: insets.bottom + space(6), gap: space(4) }}>
      <View style={{ alignSelf: 'center', width: 120, height: 120, borderRadius: 40, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-8deg' }] }}>
        <Ionicons name="notifications" size={56} color={c.primary} />
        <View style={{ position: 'absolute', top: 18, right: 22, width: 22, height: 22, borderRadius: 11, backgroundColor: c.accent, borderWidth: 3, borderColor: c.primarySoft }} />
      </View>
      <Text variant="display" style={{ textAlign: 'center', marginTop: space(6) }}>{t('notifTitle')}</Text>
      <Text tone="muted" style={{ textAlign: 'center' }}>{t('notifBody')}</Text>
      <View style={{ flex: 1 }} />
      <Button title={t('enableNotifications')} icon="notifications-outline" onPress={() => finish(true)} loading={busy} />
      <Button title={t('notNow')} variant="ghost" onPress={() => finish(false)} disabled={busy} />
    </View>
  );
}
