import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, IconBubble, Input, Text } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { normalizePhone } from '../lib/format';
import { space, useTheme } from '../theme';

export default function ProfileSetup() {
  const { c } = useTheme();
  const { t, lang } = useI18n();
  const { profile, setProfile } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [auto, setAuto] = useState(profile?.auto_submit_default ?? true);
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const e: typeof errors = {};
    if (name.trim().length < 2) e.name = t('nameRequired');
    const p = normalizePhone(phone);
    if (!/^[6-9]\d{9}$/.test(p)) e.phone = t('phoneInvalid');
    setErrors(e);
    if (e.name || e.phone) return;
    setBusy(true);
    try {
      const { profile } = await api.updateMe({ full_name: name.trim(), phone: p, auto_submit_default: auto, preferred_language: lang });
      setProfile(profile); // guard flips → app moves to the home tabs
    } catch (err) {
      toast(errorMessage(err, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: space(5), paddingTop: insets.top + space(6), paddingBottom: insets.bottom + space(5), gap: space(5), flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <IconBubble name="person" color={c.primary} bg={c.primarySoft} size={56} />
        <View style={{ gap: space(2) }}>
          <Text variant="display">{t('profileSetupTitle')}</Text>
          <Text tone="muted">{t('profileSetupBody')}</Text>
        </View>
        <Input label={t('fullName')} placeholder={t('fullNamePlaceholder')} value={name} onChangeText={setName} autoComplete="name" textContentType="name" icon="person-outline" error={errors.name} autoCapitalize="words" />
        <Input
          label={t('mobile')}
          placeholder={t('mobilePlaceholder')}
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          icon="call-outline"
          error={errors.phone}
          maxLength={16}
        />
        <Card style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text variant="bodyStrong">{t('autoSubmitTitle')}</Text>
            <Text variant="small" tone="muted">{t('autoSubmitBody')}</Text>
          </View>
          <Switch value={auto} onValueChange={setAuto} trackColor={{ true: c.primary, false: c.line }} thumbColor="#fff" accessibilityLabel={t('autoSubmitTitle')} />
        </Card>
        <View style={{ flex: 1 }} />
        <Button title={t('continue')} onPress={save} loading={busy} icon="checkmark" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
