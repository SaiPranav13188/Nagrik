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
import type { HelpReply } from '../lib/types';
import { radius, space, useTheme } from '../theme';

type Msg = { role: 'user' | 'assistant'; content: string; source?: HelpReply['source']; topic?: string | null; question?: string; rated?: boolean };

// Each suggestion names its topic, so it always gets the approved fixed answer.
const SUGGESTIONS: { key: TKey; intent: string }[] = [
  { key: 'helpQ1', intent: 'action_needed' },
  { key: 'helpQ2', intent: 'my_complaint' },
  { key: 'helpQ3', intent: 'escalation' },
];
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

  const send = async (q = text, intent?: string) => {
    const question = q.trim();
    if (!question || busy) return;
    const next: Msg[] = [...messages, { role: 'user', content: question.slice(0, 1000) }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const history = next.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
      const r = await api.helpChat(history, lang, intent);
      if (r.reply) setMessages([...next, { role: 'assistant', content: r.reply, source: r.source, topic: r.topic, question }]);
      // Older servers send no reply when unavailable; newer ones send a "not sure" reply with handoff.
      setUnavailable(!r.reply || r.handoff);
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rate = (i: number, helpful: boolean) => {
    const m = messages[i];
    if (!m || m.rated) return;
    setMessages((all) => all.map((x, j) => (j === i ? { ...x, rated: true } : x)));
    toast(t('helpThanks'), 'success');
    api.helpFeedback({ question: m.question ?? '', answer: m.content, source: m.source ?? 'none', topic: m.topic ?? null, helpful }).catch(() => {});
  };

  const bubble = (m: Msg, i: number) => {
    const mine = m.role === 'user';
    const rateable = !mine && i >= 0 && m.source && m.source !== 'none';
    return (
      <View key={i} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%', gap: space(1) }}>
        <View
          style={{
            alignSelf: mine ? 'flex-end' : 'flex-start',
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
        {m.source === 'ai' && <Text variant="small" tone="faint">{t('helpAiLabel')}</Text>}
        {rateable && !m.rated && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
            <Text variant="small" tone="muted">{t('helpWasHelpful')}</Text>
            <Pressable onPress={() => rate(i, true)} hitSlop={10} accessibilityRole="button" accessibilityLabel="👍">
              <Ionicons name="thumbs-up-outline" size={18} color={c.inkSoft} />
            </Pressable>
            <Pressable onPress={() => rate(i, false)} hitSlop={10} accessibilityRole="button" accessibilityLabel="👎">
              <Ionicons name="thumbs-down-outline" size={18} color={c.inkSoft} />
            </Pressable>
          </View>
        )}
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
            {SUGGESTIONS.map(({ key: k, intent }) => (
              <Pressable
                key={k}
                onPress={() => void send(t(k), intent)}
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
