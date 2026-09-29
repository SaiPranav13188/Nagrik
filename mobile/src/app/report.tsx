import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Input, Text } from '../components/ui';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { api, errorMessage } from '../lib/api';
import { useI18n, type TKey } from '../lib/i18n';
import { ISSUE_META } from '../lib/format';
import type { IssueType } from '../lib/types';
import { radius, space, useTheme } from '../theme';

type Loc =
  | { kind: 'pending' }
  | { kind: 'gps'; latitude: number; longitude: number; accuracy: number | null; label: string | null }
  | { kind: 'manual' }
  | { kind: 'denied' };

/** Resizes to ≤1600px, JPEG-compresses, and returns base64 for upload (≈200–500 KB). */
async function compress(uri: string, width?: number): Promise<{ uri: string; base64: string | null }> {
  try {
    const ctx = ImageManipulator.manipulate(uri);
    if (!width || width > 1600) ctx.resize({ width: 1600 });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ compress: 0.72, format: SaveFormat.JPEG, base64: true });
    return { uri: out.uri, base64: out.base64 ?? (await readBase64(out.uri)) };
  } catch {
    return { uri, base64: await readBase64(uri) }; // Upload the original rather than fail.
  }
}

async function readBase64(uri: string): Promise<string | null> {
  try {
    const blob = await (await fetch(uri)).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result.split(',')[1] ?? null : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const ANALYZE_STEPS: TKey[] = ['analyzing1', 'analyzing2', 'analyzing3', 'analyzing4'];

export default function Report() {
  const { c, shadow } = useTheme();
  const { t, lang } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const [photo, setPhoto] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [loc, setLoc] = useState<Loc>({ kind: 'pending' });
  const [manualAddress, setManualAddress] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<'compose' | 'analyzing'>('compose');
  const [clarify, setClarify] = useState<{ intakeId: string; photoUrl: string; question: string; options: Array<{ issue_type: IssueType; label: string }> } | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  // ───────── location ─────────
  const locate = useCallback(async () => {
    setLoc({ kind: 'pending' });
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') return setLoc({ kind: 'denied' });
      const pos =
        (await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<null>((r) => setTimeout(() => r(null), 12000)),
        ])) ?? (await Location.getLastKnownPositionAsync());
      if (!pos) return setLoc({ kind: 'denied' });
      const { latitude, longitude, accuracy } = pos.coords;
      setLoc({ kind: 'gps', latitude, longitude, accuracy: accuracy ?? null, label: null });
      // Friendly address preview: same OpenStreetMap source the agents use, device geocoder as fallback.
      let label: string | null = null;
      try {
        label = (await api.geocode(latitude, longitude)).label;
      } catch {
        try {
          const [a] = await Location.reverseGeocodeAsync({ latitude, longitude });
          if (a) label = [a.name, a.street, a.district ?? a.subregion, a.city].filter((x, i, arr) => x && arr.indexOf(x) === i).slice(0, 3).join(', ') || null;
        } catch {
          // Coordinates alone are fine; the server geocodes authoritatively.
        }
      }
      if (label) setLoc({ kind: 'gps', latitude, longitude, accuracy: accuracy ?? null, label });
    } catch {
      setLoc({ kind: 'denied' });
    }
  }, []);

  useEffect(() => {
    void locate();
  }, [locate]);

  // ───────── photo ─────────
  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(t('takePhoto'), t('cameraDenied'), [
        { text: t('cancel'), style: 'cancel' },
        { text: 'Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85, exif: false });
    if (!r.canceled && r.assets[0]) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const p = await compress(r.assets[0].uri, r.assets[0].width);
      setPhoto(p.uri);
      setPhotoBase64(p.base64);
    }
  };

  const pickPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.85, exif: false });
    if (!r.canceled && r.assets[0]) {
      const p = await compress(r.assets[0].uri, r.assets[0].width);
      setPhoto(p.uri);
      setPhotoBase64(p.base64);
    }
  };

  // ───────── analyze ─────────
  const locationReady = loc.kind === 'gps' || manualAddress.trim().length >= 6;
  const run = async (extra?: { clarificationAnswer: IssueType }) => {
    if (!photo && !clarify) return toast(t('needPhoto'), 'error');
    if (!locationReady) return toast(t('needLocation'), 'error');
    setPhase('analyzing');
    setClarify(null);
    try {
      const r = await api.analyze({
        ...(extra && clarify ? { photoUrl: clarify.photoUrl, intakeId: clarify.intakeId, clarificationAnswer: extra.clarificationAnswer } : (photoBase64 ? { photoBase64 } : { photoUri: photo! })),
        ...(loc.kind === 'gps' ? { latitude: loc.latitude, longitude: loc.longitude } : {}),
        manualAddress: loc.kind === 'gps' ? undefined : manualAddress.trim(),
        note: note.trim() || undefined,
      });
      if (r.result === 'created') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        router.replace(`/complaint/${r.complaint.id}`);
        return;
      }
      setPhase('compose');
      if (r.result === 'clarification') setClarify(r);
      else setRejected(r.reason);
    } catch (e) {
      setPhase('compose');
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    }
  };

  if (phase === 'analyzing') return <Analyzing photo={photo} />;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingTop: insets.top + space(2), paddingHorizontal: space(4), paddingBottom: space(2), flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityLabel={t('close')} style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
          <Ionicons name="close" size={22} color={c.ink} />
        </Pressable>
        <Text variant="heading" style={{ flex: 1, textAlign: 'center', marginRight: 40 }}>{t('reportTitle')}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4), paddingBottom: space(8) }} keyboardShouldPersistTaps="handled">
        {/* Photo */}
        {photo ? (
          <View style={{ borderRadius: radius.xl, overflow: 'hidden', ...shadow(3) }}>
            <Image source={photo} style={{ width: '100%', aspectRatio: 4 / 3.4, backgroundColor: c.surfaceAlt }} contentFit="cover" transition={200} accessibilityLabel="Selected photo" />
            <View style={{ position: 'absolute', bottom: space(3), right: space(3), flexDirection: 'row', gap: space(2) }}>
              <Pressable onPress={takePhoto} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill }}>
                <Ionicons name="camera-reverse-outline" size={16} color="#fff" />
                <Text variant="smallStrong" color="#fff">{t('retake')}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={takePhoto}
            accessibilityRole="button"
            accessibilityLabel={t('takePhoto')}
            style={({ pressed }) => ({
              aspectRatio: 4 / 3.4,
              borderRadius: radius.xl,
              borderWidth: 2,
              borderStyle: 'dashed',
              borderColor: c.primary + '66',
              backgroundColor: c.primarySoft + (pressed ? 'FF' : '88'),
              alignItems: 'center',
              justifyContent: 'center',
              gap: space(3),
            })}
          >
            <View style={{ width: 76, height: 76, borderRadius: 26, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', ...shadow(4) }}>
              <Ionicons name="camera" size={36} color={c.primaryInk} />
            </View>
            <Text variant="heading">{t('takePhoto')}</Text>
            <Text variant="small" tone="muted">{t('photoHint')}</Text>
          </Pressable>
        )}
        {!photo && <Button title={t('chooseGallery')} variant="secondary" icon="images-outline" size="md" onPress={pickPhoto} />}

        {/* Location */}
        <Card style={{ gap: space(3) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
            <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: loc.kind === 'gps' ? c.primarySoft : c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={loc.kind === 'gps' ? 'location' : 'location-outline'} size={20} color={loc.kind === 'gps' ? c.primary : c.muted} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="caption" tone="muted">{t('location')}</Text>
              {loc.kind === 'pending' && <Text variant="bodyStrong" tone="muted">{t('detectingLocation')}</Text>}
              {loc.kind === 'gps' && (
                <>
                  <Text variant="bodyStrong" numberOfLines={2}>{loc.label ?? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`}</Text>
                  {!!loc.accuracy && <Text variant="small" tone="faint">{t('accuracy', { m: Math.round(loc.accuracy) })}</Text>}
                </>
              )}
              {(loc.kind === 'denied' || loc.kind === 'manual') && <Text variant="small" tone="muted">{loc.kind === 'denied' ? t('locationDenied') : t('typeAddress')}</Text>}
            </View>
            {loc.kind === 'pending' ? null : (
              <Pressable onPress={loc.kind === 'gps' ? () => setLoc({ kind: 'manual' }) : locate} hitSlop={8}>
                <Ionicons name={loc.kind === 'gps' ? 'create-outline' : 'locate'} size={22} color={c.primary} accessibilityLabel={loc.kind === 'gps' ? t('useTypedAddress') : t('useGps')} />
              </Pressable>
            )}
          </View>
          {(loc.kind === 'denied' || loc.kind === 'manual') && <Input placeholder={t('addressPlaceholder')} value={manualAddress} onChangeText={setManualAddress} icon="map-outline" multiline style={{ minHeight: 44 }} />}
        </Card>

        {/* Note */}
        <Input label={t('addDetails')} placeholder={t('detailsPlaceholder')} value={note} onChangeText={setNote} multiline maxLength={500} style={{ minHeight: 70 }} icon="chatbox-ellipses-outline" />
      </ScrollView>

      <View style={{ padding: space(4), paddingBottom: insets.bottom + space(3), backgroundColor: c.bg, borderTopWidth: 1, borderTopColor: c.line }}>
        <Button title={t('analyzeAndFile')} icon="sparkles" onPress={() => run()} disabled={!photo || !locationReady} />
      </View>

      {/* Clarification */}
      <Sheet visible={!!clarify} onClose={() => setClarify(null)}>
        <View style={{ gap: space(4) }}>
          <View style={{ gap: 4 }}>
            <Text variant="caption" tone="primary">{t('clarifyTitle')}</Text>
            <Text variant="title">{lang === 'en' ? clarify?.question : t('clarifyQuestion')}</Text>
            <Text tone="muted">{t('clarifyBody')}</Text>
          </View>
          <View style={{ gap: space(2) }}>
            {clarify?.options.map((o) => {
              const m = ISSUE_META[o.issue_type];
              return (
                <Pressable
                  key={o.issue_type}
                  onPress={() => run({ clarificationAnswer: o.issue_type })}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space(3), padding: space(3.5), borderRadius: radius.md, borderWidth: 1.5, borderColor: pressed ? c.primary : c.line, backgroundColor: pressed ? c.primarySoft : c.surface })}
                >
                  <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: m.tint + '22', alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name={m.icon} size={20} color={m.tint} />
                  </View>
                  <Text variant="bodyStrong" style={{ flex: 1 }}>{t(m.key) || o.label}</Text>
                  <Ionicons name="chevron-forward" size={18} color={c.faint} />
                </Pressable>
              );
            })}
          </View>
        </View>
      </Sheet>

      {/* Rejected */}
      <Sheet visible={!!rejected} onClose={() => setRejected(null)}>
        <View style={{ gap: space(4), alignItems: 'center' }}>
          <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: c.warningSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="image-outline" size={30} color={c.warning} />
          </View>
          <Text variant="title" style={{ textAlign: 'center' }}>{t('rejectedTitle')}</Text>
          <Text tone="muted" style={{ textAlign: 'center' }}>{rejected}</Text>
          <Button
            title={t('tryAnotherPhoto')}
            icon="camera-outline"
            style={{ alignSelf: 'stretch' }}
            onPress={() => {
              setRejected(null);
              setPhoto(null);
              setPhotoBase64(null);
            }}
          />
        </View>
      </Sheet>
    </KeyboardAvoidingView>
  );
}

function Analyzing({ photo }: { photo: string | null }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const scan = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(s + 1, ANALYZE_STEPS.length - 1)), 2600);
    const loop = Animated.loop(Animated.timing(scan, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => {
      clearInterval(id);
      loop.stop();
    };
  }, [scan]);

  return (
    <View style={{ flex: 1, backgroundColor: '#050A14', paddingTop: insets.top + space(10), paddingHorizontal: space(6), gap: space(8) }} accessibilityLiveRegion="polite">
      <View style={{ borderRadius: radius.xl, overflow: 'hidden', aspectRatio: 1, alignSelf: 'stretch' }}>
        {photo && <Image source={photo} style={{ width: '100%', height: '100%', opacity: 0.8 }} contentFit="cover" />}
        <Animated.View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 3,
            backgroundColor: '#2DD4BF',
            shadowColor: '#2DD4BF',
            shadowOpacity: 1,
            shadowRadius: 12,
            transform: [{ translateY: scan.interpolate({ inputRange: [0, 1], outputRange: [0, 320] }) }],
          }}
        />
        {['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].map((k) => (
          <View
            key={k}
            style={{
              position: 'absolute',
              width: 28,
              height: 28,
              borderColor: '#2DD4BF',
              ...(k.includes('top') ? { top: 12, borderTopWidth: 3 } : { bottom: 12, borderBottomWidth: 3 }),
              ...(k.includes('Left') ? { left: 12, borderLeftWidth: 3 } : { right: 12, borderRightWidth: 3 }),
            }}
          />
        ))}
      </View>
      <View style={{ gap: space(3) }}>
        {ANALYZE_STEPS.map((k, i) => (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: space(3), opacity: i > step ? 0.35 : 1 }}>
            <Ionicons name={i < step ? 'checkmark-circle' : i === step ? 'ellipse' : 'ellipse-outline'} size={20} color={i <= step ? '#2DD4BF' : '#64748B'} />
            <Text variant={i === step ? 'bodyStrong' : 'body'} color="#F1F5F9">{t(k)}</Text>
          </View>
        ))}
        <Text variant="small" color="#94A3B8" style={{ marginTop: space(2) }}>{t('analyzingNote')}</Text>
      </View>
    </View>
  );
}
