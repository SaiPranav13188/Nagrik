import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Input, Skeleton, Text } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { space, useTheme } from '../../theme';

export default function EditDraft() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [subject, setSubject] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'save' | 'ai' | null>(null);

  useEffect(() => {
    // Opening the editor pauses any pending auto-submission so edits are never raced.
    api
      .hold(id)
      .catch(() => api.complaint(id))
      .then((d) => {
        setSubject(d.complaint.draft_subject ?? '');
        setText(d.complaint.draft_text ?? '');
      })
      .catch((e) => toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error'));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy('save');
    try {
      await api.editDraft(id, subject!.trim(), text.trim());
      toast(t('saveChanges'), 'success');
      router.back();
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    setBusy('ai');
    try {
      const d = await api.redraft(id);
      setSubject(d.complaint.draft_subject ?? '');
      setText(d.complaint.draft_text ?? '');
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(null);
    }
  };

  const valid = (subject?.trim().length ?? 0) >= 5 && text.trim().length >= 50 && text.length <= 1500;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: Platform.OS === 'ios' ? space(4) : insets.top + space(2), paddingHorizontal: space(4), paddingBottom: space(2) }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('close')}>
          <Ionicons name="close" size={26} color={c.ink} />
        </Pressable>
        <Text variant="heading" style={{ flex: 1, textAlign: 'center' }}>{t('editDraft')}</Text>
        <View style={{ width: 26 }} />
      </View>
      {subject === null ? (
        <View style={{ padding: space(4), gap: space(3) }}>
          <Skeleton height={52} />
          <Skeleton height={300} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }} keyboardShouldPersistTaps="handled">
          <Input label={t('subject')} value={subject} onChangeText={setSubject} maxLength={100} hint={t('charCount', { n: subject.length, max: 100 })} />
          <Input label={t('complaintText')} value={text} onChangeText={setText} multiline maxLength={1500} style={{ minHeight: 320, fontSize: 15, lineHeight: 22 }} hint={t('charCount', { n: text.length, max: 1500 })} />
          <Button title={t('regenerate')} variant="ghost" icon="sparkles-outline" size="md" loading={busy === 'ai'} onPress={regenerate} />
        </ScrollView>
      )}
      <View style={{ padding: space(4), paddingBottom: insets.bottom + space(3), borderTopWidth: 1, borderTopColor: c.line }}>
        <Button title={t('saveChanges')} icon="checkmark" onPress={save} loading={busy === 'save'} disabled={!valid || busy === 'ai'} />
      </View>
    </KeyboardAvoidingView>
  );
}
