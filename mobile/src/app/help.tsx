import React, { useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Text } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { APP_VERSION, SUPPORT_EMAIL } from '../lib/config';
import { useI18n, type TKey } from '../lib/i18n';
import { radius, space, useTheme } from '../theme';

type Msg = { role: 'user' | 'assistant'; content: string };

const SUGGESTIONS: TKey[] = ['helpQ1', 'helpQ2', 'helpQ3'];
/** The server accepts at most 12 messages; older turns matter little for help questions. */
const MAX_HISTORY = 10;

export default function Help() {
  const { c } = useTheme();
  const { t, lang } = useI18n();
  const { profile } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const emailSupport = async () => {
    const body = `\n\n—\nApp version: ${APP_VERSION}\nAccount: ${profile?.id ?? '-'}`;
    const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Nagrik help')}&body=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(url);
    } catch {
      toast(t('noEmailApp', { email: SUPPORT_EMAIL }), 'error');
    }
  };

  const send = async (q = text) => {
    const question = q.trim();
    if (!question || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: question.slice(0, 1000) }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const r = await api.helpChat(next.slice(-MAX_HISTORY), lang);
      if (r.reply) {
        setMessages([...next, { role: 'assistant', content: r.reply }]);
        setUnavailable(false);
      } else {
        setUnavailable(true);
      }
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const bubble = (m: Msg, i: number) => {
    const mine = m.role === 'user';
    return (
      <View
        key={i}
        style={{
          alignSelf: mine ? 'flex-end' : 'flex-start',
          maxWidth: '85%',
          paddingHorizontal: space(4),
          paddingVertical: space(3),
          borderRadius: radius.lg,
          borderBottomRightRadius: mine ? 6 : radius.lg,
          borderBottomLeftRadius: mine ? radius.lg : 6,
          backgroundColor: mine ? c.primary : c.surface,
          borderWidth: mine ? 0 : 1,
          borderColor: c.line,
        }}
      >
        <Text color={mine ? c.primaryInk : c.ink} selectable>{m.content}</Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingTop: insets.top + space(2), paddingHorizontal: space(4), paddingBottom: space(2) }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('back')} style={{ width: 40, height: 40, justifyContent: 'center' }}>
          <Ionicons name="arrow-back" size={24} color={c.ink} />
        </Pressable>
        <Text variant="title" style={{ flex: 1 }}>{t('helpTitle')}</Text>
        <Button title={t('emailSupport')} icon="mail-outline" variant="secondary" size="sm" onPress={emailSupport} />
      </View>

      <ScrollView
        ref={scroll}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space(4), gap: space(3) }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {bubble({ role: 'assistant', content: t('helpIntro') }, -1)}
        {messages.length === 0 && (
          <View style={{ gap: space(2), alignItems: 'flex-start' }}>
            {SUGGESTIONS.map((k) => (
              <Pressable
                key={k}
                onPress={() => void send(t(k))}
                style={({ pressed }) => ({ paddingHorizontal: space(4), paddingVertical: space(2), borderRadius: radius.pill, borderWidth: 1.5, borderColor: c.primary, opacity: pressed ? 0.7 : 1 })}
              >
                <Text variant="bodyStrong" color={c.primary}>{t(k)}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {messages.map(bubble)}
        {busy && (
          <View style={{ alignSelf: 'flex-start', padding: space(3) }}>
            <ActivityIndicator color={c.primary} />
          </View>
        )}
        {unavailable && !busy && (
          <View style={{ gap: space(3), padding: space(4), borderRadius: radius.lg, backgroundColor: c.surfaceAlt }}>
            <Text tone="soft">{t('helpUnavailable')}</Text>
            <Button title={t('emailSupport')} icon="mail-outline" size="md" onPress={emailSupport} />
          </View>
        )}
      </ScrollView>

      <View style={{ paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: insets.bottom + space(3), gap: space(2), borderTopWidth: 1, borderColor: c.line, backgroundColor: c.bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space(2) }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={t('helpPlaceholder')}
            placeholderTextColor={c.faint}
            multiline
            maxLength={1000}
            style={{ flex: 1, minHeight: 48, maxHeight: 120, paddingHorizontal: space(4), paddingVertical: space(3), borderRadius: radius.lg, borderWidth: 1.5, borderColor: c.line, backgroundColor: c.surface, color: c.ink, fontSize: 16 }}
          />
          <Pressable
            onPress={() => void send()}
            disabled={!text.trim() || busy}
            accessibilityRole="button"
            accessibilityLabel={t('send')}
            style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', opacity: !text.trim() || busy ? 0.4 : 1 }}
          >
            <Ionicons name="send" size={20} color={c.primaryInk} />
          </Pressable>
        </View>
        <Text variant="small" tone="faint" style={{ textAlign: 'center' }}>{t('helpDisclaimer')}</Text>
      </View>
    </KeyboardAvoidingView>
  );
}
