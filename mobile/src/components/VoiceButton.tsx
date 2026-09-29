import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { api, errorMessage } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { readBase64 } from '../lib/media';
import { radius, space, useTheme } from '../theme';
import { PulseDot, Text } from './ui';
import { useToast } from './Toast';

const MAX_SECONDS = 60;

// Mono, modest bitrate: speech stays clear and a minute of audio is ~500 KB.
const OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000, sampleRate: 22050 };

/**
 * Tap to speak (Telugu / Hindi / English), tap again to stop. The audio is transcribed by Gemini
 * and handed back as text so the citizen can read and edit it before filing.
 */
export function VoiceButton({ onText }: { onText: (transcript: string, english: string) => void }) {
  const { c } = useTheme();
  const { t, lang } = useI18n();
  const toast = useToast();
  const recorder = useAudioRecorder(OPTIONS);
  const [state, setState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const start = async () => {
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(t('voiceTap'), t('micDenied'), [
        { text: t('cancel'), style: 'cancel' },
        { text: 'Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setSeconds(0);
      setState('recording');
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) void stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      toast(t('somethingWrong'), 'error');
    }
  };

  const stop = async () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setState('processing');
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      const uri = recorder.uri;
      const b64 = uri ? await readBase64(uri) : null;
      if (!b64) throw new Error('no audio');
      const mime = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
      const r = await api.transcribe(b64, mime, lang);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onText(r.transcript, r.english);
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setState('idle');
    }
  };

  const recording = state === 'recording';
  return (
    <Pressable
      onPress={() => (state === 'idle' ? start() : recording ? stop() : undefined)}
      disabled={state === 'processing'}
      accessibilityRole="button"
      accessibilityLabel={recording ? t('voiceRecording') : t('voiceTap')}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space(3),
        padding: space(3),
        borderRadius: radius.md,
        borderWidth: 1.5,
        borderColor: recording ? c.danger : c.line,
        backgroundColor: recording ? c.dangerSoft : pressed ? c.surfaceAlt : c.surface,
      })}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: recording ? c.danger : c.primary, alignItems: 'center', justifyContent: 'center' }}>
        {state === 'processing' ? <ActivityIndicator color="#fff" /> : <Ionicons name={recording ? 'stop' : 'mic'} size={20} color="#fff" />}
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong">{recording ? t('voiceRecording') : state === 'processing' ? t('voiceProcessing') : t('voiceTap')}</Text>
        {state === 'idle' && <Text variant="small" tone="muted">తెలుగు · हिन्दी · English</Text>}
      </View>
      {recording && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <PulseDot color={c.danger} size={6} />
          <Text variant="smallStrong" color={c.danger}>
            0:{String(seconds).padStart(2, '0')}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
