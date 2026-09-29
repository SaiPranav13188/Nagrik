import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Input, Text } from '../components/ui';
import { useToast } from '../components/Toast';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { space, useTheme } from '../theme';

/** Must match Supabase → Authentication → Email → "Email OTP Length". */
const OTP_LENGTH = Number(process.env.EXPO_PUBLIC_OTP_LENGTH) || 6;

export default function SignIn() {
  const { c } = useTheme();
  const { t } = useI18n();
  const { sendEmailCode, verifyEmailCode } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (!cooldown) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const send = async () => {
    const e = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) return setError(t('invalidEmail'));
    setError(null);
    setBusy(true);
    try {
      await sendEmailCode(e);
      setEmail(e);
      setStep('code');
      setCooldown(45);
    } catch (err) {
      toast((err as Error).message || t('somethingWrong'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value = code) => {
    if (value.length !== OTP_LENGTH) return;
    setBusy(true);
    try {
      await verifyEmailCode(email, value);
    } catch (err) {
      setError((err as Error).message || t('somethingWrong'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: space(5), paddingTop: insets.top + space(3), gap: space(5), flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => (step === 'code' ? setStep('email') : router.back())} hitSlop={12} accessibilityLabel={t('back')} style={{ width: 40, height: 40, justifyContent: 'center' }}>
          <Ionicons name="arrow-back" size={24} color={c.ink} />
        </Pressable>
        <View style={{ gap: space(2) }}>
          <Text variant="display">{step === 'email' ? t('signInTitle') : t('enterCode')}</Text>
          <Text tone="muted">{step === 'email' ? t('signInSubtitle') : t('codeSentTo', { email })}</Text>
        </View>

        {step === 'email' ? (
          <Input
            label={t('email')}
            placeholder={t('emailPlaceholder')}
            value={email}
            onChangeText={(v) => {
              setEmail(v);
              setError(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            icon="mail-outline"
            error={error}
            returnKeyType="send"
            onSubmitEditing={send}
            autoFocus
          />
        ) : (
          <Input
            placeholder={"•".repeat(OTP_LENGTH)}
            value={code}
            onChangeText={(v) => {
              const d = v.replace(/\D/g, '').slice(0, OTP_LENGTH);
              setCode(d);
              setError(null);
              if (d.length === OTP_LENGTH) void verify(d);
            }}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={OTP_LENGTH}
            error={error}
            style={{ fontSize: 28, letterSpacing: 12, textAlign: 'center' }}
            autoFocus
          />
        )}

        <View style={{ flex: 1 }} />
        {step === 'email' ? (
          <Button title={t('sendCode')} onPress={send} loading={busy} icon="paper-plane-outline" />
        ) : (
          <View style={{ gap: space(3) }}>
            <Button title={t('verify')} onPress={() => verify()} loading={busy} disabled={code.length !== OTP_LENGTH} />
            <Button title={cooldown ? `${t('resendCode')} (${cooldown})` : t('resendCode')} variant="ghost" disabled={!!cooldown || busy} onPress={send} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
