import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Switch, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Divider, Input, Text } from '../../components/ui';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { APP_VERSION, PRIVACY_POLICY_URL } from '../../lib/config';
import { normalizePhone } from '../../lib/format';
import { readBase64 } from '../../lib/media';
import { LANGUAGES, useI18n } from '../../lib/i18n';
import { enableNotifications, notificationPermission } from '../../lib/notifications';
import { radius, space, useTheme } from '../../theme';

function Row({ icon, label, value, onPress, right }: { icon: keyof typeof Ionicons.glyphMap; label: string; value?: string; onPress?: () => void; right?: React.ReactNode }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(3), opacity: pressed ? 0.7 : 1 })} accessibilityRole={onPress ? 'button' : undefined}>
      <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name={icon} size={18} color={c.inkSoft} />
      </View>
      <Text variant="bodyStrong" style={{ flex: 1 }}>{label}</Text>
      {value ? <Text tone="muted" numberOfLines={1} style={{ maxWidth: '45%' }}>{value}</Text> : null}
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={c.faint} /> : null)}
    </Pressable>
  );
}

export default function ProfileTab() {
  const { c } = useTheme();
  const { t, lang, setLang } = useI18n();
  const { profile, setProfile, signOut } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [editOpen, setEditOpen] = useState(false);
  const [sheet, setSheet] = useState<'lang' | 'how' | 'privacy' | null>(null);
  const [name, setName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<string>('undetermined');
  const [health, setHealth] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  useEffect(() => {
    notificationPermission().then(setPerm);
    api.health().then((h) => setHealth(h.portal_mode === 'sandbox' ? t('statusOnlineTest') : t('statusOnline'))).catch(() => setHealth(t('statusOffline')));
  }, []);

  const update = async (patch: Parameters<typeof api.updateMe>[0], okMsg?: string) => {
    try {
      const r = await api.updateMe(patch);
      setProfile(r.profile);
      if (okMsg) toast(okMsg, 'success');
      return true;
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
      return false;
    }
  };

  const saveDetails = async () => {
    if (name.trim().length < 2) return toast(t('nameRequired'), 'error');
    const p = normalizePhone(phone);
    if (!/^[6-9]\d{9}$/.test(p)) return toast(t('phoneInvalid'), 'error');
    setBusy(true);
    if (await update({ full_name: name.trim(), phone: p }, t('profileSaved'))) setEditOpen(false);
    setBusy(false);
  };

  const uploadPhoto = async (r: ImagePicker.ImagePickerResult) => {
    const asset = !r.canceled ? r.assets[0] : undefined;
    if (!asset) return;
    setPhotoBusy(true);
    try {
      // Square 512px JPEG keeps the upload small (≈40–80 KB).
      const ctx = ImageManipulator.manipulate(asset.uri);
      ctx.resize({ width: 512, height: 512 });
      const out = await (await ctx.renderAsync()).saveAsync({ compress: 0.8, format: SaveFormat.JPEG, base64: true });
      const base64 = out.base64 ?? (await readBase64(out.uri));
      if (!base64) throw new Error('unreadable');
      const r2 = await api.setAvatar(base64);
      setProfile(r2.profile);
      toast(t('photoUpdated'), 'success');
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setPhotoBusy(false);
    }
  };

  const changePhoto = () => {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.85, exif: false };
    Alert.alert(t('profilePhoto'), undefined, [
      {
        text: t('takePhoto'),
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) return Alert.alert(t('takePhoto'), t('cameraDenied'), [{ text: t('cancel'), style: 'cancel' }, { text: 'Settings', onPress: () => Linking.openSettings() }]);
          void uploadPhoto(await ImagePicker.launchCameraAsync(opts));
        },
      },
      { text: t('chooseGallery'), onPress: async () => void uploadPhoto(await ImagePicker.launchImageLibraryAsync(opts)) },
      { text: t('cancel'), style: 'cancel' },
    ]);
  };

  const initials =(profile?.full_name ?? '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ paddingTop: insets.top + space(4), padding: space(4), gap: space(4), paddingBottom: space(28) }}>
      <Text variant="display" style={{ paddingHorizontal: space(1) }}>{t('profileTitle')}</Text>

      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space(4) }} onPress={() => setEditOpen(true)}>
        <Pressable onPress={changePhoto} disabled={photoBusy} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('profilePhoto')}>
          <View style={{ width: 60, height: 60, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {profile?.avatar_url ? (
              <Image source={{ uri: profile.avatar_url }} style={{ width: 60, height: 60 }} contentFit="cover" transition={150} />
            ) : (
              <Text variant="title" color={c.primaryInk}>{initials}</Text>
            )}
            {photoBusy && (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          </View>
          <View style={{ position: 'absolute', right: -4, bottom: -4, width: 24, height: 24, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="camera" size={13} color={c.primary} />
          </View>
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">{profile?.full_name}</Text>
          <Text tone="muted">+91 {profile?.phone}</Text>
          {profile?.email ? <Text variant="small" tone="faint">{profile.email}</Text> : null}
        </View>
        <Ionicons name="create-outline" size={20} color={c.primary} />
      </Card>

      <Card style={{ paddingVertical: space(1) }}>
        <Text variant="caption" tone="muted" style={{ marginTop: space(3) }}>{t('preferences')}</Text>
        <Row
          icon="flash-outline"
          label={t('autoSubmitTitle')}
          right={<Switch value={profile?.auto_submit_default ?? true} onValueChange={(v) => void update({ auto_submit_default: v })} trackColor={{ true: c.primary, false: c.line }} thumbColor="#fff" accessibilityLabel={t('autoSubmitTitle')} />}
        />
        <Text variant="small" tone="muted" style={{ marginTop: -space(1), marginBottom: space(2), marginLeft: 48 }}>{t('autoSubmitBody')}</Text>
        <Divider />
        <Row icon="language-outline" label={t('language')} value={LANGUAGES.find((l) => l.code === lang)?.native} onPress={() => setSheet('lang')} />
        <Divider />
        <Row
          icon="notifications-outline"
          label={t('notifications')}
          value={perm === 'unsupported' ? t('notificationsInApp') : perm === 'granted' ? t('notificationsOn') : t('notificationsOff')}
          onPress={async () => {
            if (perm === 'unsupported') return;
            if (perm === 'denied') return Linking.openSettings();
            const ok = await enableNotifications();
            setPerm(ok ? 'granted' : await notificationPermission());
          }}
        />
      </Card>

      <Card style={{ paddingVertical: space(1) }}>
        <Row icon="chatbubbles-outline" label={t('helpSupport')} onPress={() => router.push('/help')} />
        <Divider />
        <Row icon="sparkles-outline" label={t('howItWorks')} onPress={() => setSheet('how')} />
        <Divider />
        <Row icon="lock-closed-outline" label={t('privacy')} onPress={() => setSheet('privacy')} />
        <Divider />
        <Row icon="pulse-outline" label={t('serverStatus')} value={health ?? '—'} />
      </Card>

      <Button
        title={t('signOut')}
        variant="danger"
        icon="log-out-outline"
        onPress={() =>
          Alert.alert(t('signOut'), t('signOutConfirm'), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('signOut'), style: 'destructive', onPress: () => void signOut() },
          ])
        }
      />
      <Button
        title={t('deleteAccount')}
        variant="ghost"
        icon="trash-outline"
        loading={deleting}
        onPress={() =>
          Alert.alert(t('deleteAccount'), t('deleteAccountConfirm'), [
            { text: t('cancel'), style: 'cancel' },
            {
              text: t('deleteAccountYes'),
              style: 'destructive',
              onPress: async () => {
                setDeleting(true);
                try {
                  await api.deleteAccount();
                  toast(t('deleteAccountDone'), 'success');
                  await signOut();
                } catch (e) {
                  toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
                } finally {
                  setDeleting(false);
                }
              },
            },
          ])
        }
      />
      <Text variant="small" tone="faint" style={{ textAlign: 'center' }}>{t('independentApp')}</Text>
      <Text variant="small" tone="faint" style={{ textAlign: 'center' }}>{t('appName')} · {t('version', { v: APP_VERSION })}</Text>

      <Sheet visible={editOpen} onClose={() => setEditOpen(false)}>
        <View style={{ gap: space(4) }}>
          <Text variant="title">{t('personalDetails')}</Text>
          <Input label={t('fullName')} value={name} onChangeText={setName} icon="person-outline" autoCapitalize="words" />
          <Input label={t('mobile')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" icon="call-outline" maxLength={16} />
          <Button title={t('save')} onPress={saveDetails} loading={busy} />
        </View>
      </Sheet>

      <Sheet visible={sheet === 'lang'} onClose={() => setSheet(null)}>
        <View style={{ gap: space(2) }}>
          <Text variant="title" style={{ marginBottom: space(2) }}>{t('chooseLanguage')}</Text>
          {LANGUAGES.map((l) => (
            <Pressable
              key={l.code}
              onPress={() => {
                setLang(l.code);
                void update({ preferred_language: l.code });
                setSheet(null);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', padding: space(4), borderRadius: radius.md, borderWidth: 1.5, borderColor: lang === l.code ? c.primary : c.line, backgroundColor: lang === l.code ? c.primarySoft : c.surface }}
            >
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">{l.native}</Text>
                <Text variant="small" tone="muted">{l.label}</Text>
              </View>
              {lang === l.code && <Ionicons name="checkmark-circle" size={22} color={c.primary} />}
            </Pressable>
          ))}
        </View>
      </Sheet>

      <Sheet visible={sheet === 'how' || sheet === 'privacy'} onClose={() => setSheet(null)}>
        <View style={{ gap: space(3) }}>
          <Text variant="title">{sheet === 'how' ? t('howItWorks') : t('privacy')}</Text>
          <Text tone="soft">{sheet === 'how' ? t('howItWorksBody') : t('privacyBody')}</Text>
          {sheet === 'privacy' && <Button title={t('privacyPolicy')} variant="secondary" icon="open-outline" onPress={() => Linking.openURL(PRIVACY_POLICY_URL)} />}
          <Button title={t('close')} variant="secondary" onPress={() => setSheet(null)} />
        </View>
      </Sheet>
    </ScrollView>
  );
}
