import React, { useRef, useState } from 'react';
import { FlatList, Pressable, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Text } from '../components/ui';
import { useToast } from '../components/Toast';
import { useAuth } from '../lib/auth';
import { errorMessage } from '../lib/api';
import { LANGUAGES, useI18n, type TKey } from '../lib/i18n';
import { BRAND_GRADIENT, radius, space, useTheme } from '../theme';

const SLIDES: Array<{ icon: keyof typeof Ionicons.glyphMap; title: TKey; body: TKey; chips: Array<keyof typeof Ionicons.glyphMap> }> = [
  { icon: 'camera', title: 'welcome1Title', body: 'welcome1Body', chips: ['car-outline', 'bulb-outline', 'trash-outline', 'water-outline'] },
  { icon: 'business', title: 'welcome2Title', body: 'welcome2Body', chips: ['search-outline', 'create-outline', 'globe-outline', 'receipt-outline'] },
  { icon: 'shield-checkmark', title: 'welcome3Title', body: 'welcome3Body', chips: ['refresh-outline', 'trending-up-outline', 'notifications-outline', 'trophy-outline'] },
];

export default function Welcome() {
  const { c } = useTheme();
  const { t, lang, setLang } = useI18n();
  const { mode, startLocalSession } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const list = useRef<FlatList>(null);

  const next = async () => {
    if (index < SLIDES.length - 1) {
      // Programmatic scrolls don't fire momentum events, so track the index ourselves.
      list.current?.scrollToIndex({ index: index + 1, animated: true });
      setIndex(index + 1);
      return;
    }
    if (mode === 'supabase') return router.push('/sign-in');
    setBusy(true);
    try {
      await startLocalSession();
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <LinearGradient colors={BRAND_GRADIENT} style={{ paddingTop: insets.top + space(3), paddingBottom: space(16), borderBottomLeftRadius: 36, borderBottomRightRadius: 36 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space(5) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
            <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="flag" size={18} color="#fff" />
            </View>
            <Text variant="heading" color="#fff">{t('appName')}</Text>
          </View>
          <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: radius.pill, padding: 3 }}>
            {LANGUAGES.map((l) => (
              <Pressable
                key={l.code}
                onPress={() => setLang(l.code)}
                accessibilityRole="button"
                accessibilityState={{ selected: lang === l.code }}
                accessibilityLabel={l.label}
                style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: lang === l.code ? '#fff' : 'transparent' }}
              >
                <Text variant="smallStrong" color={lang === l.code ? '#0B4F4A' : '#fff'}>{l.native}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        <Text variant="display" color="#fff" style={{ paddingHorizontal: space(5), marginTop: space(8) }}>
          {t('tagline')}
        </Text>
      </LinearGradient>

      <FlatList
        ref={list}
        data={SLIDES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(s) => s.title}
        onScroll={(e) => {
          const i = Math.round(e.nativeEvent.contentOffset.x / width);
          if (i !== index && i >= 0 && i < SLIDES.length) setIndex(i);
        }}
        scrollEventThrottle={32}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        style={{ marginTop: -space(12), flexGrow: 0 }}
        renderItem={({ item }) => (
          <View style={{ width, paddingHorizontal: space(5) }}>
            <View style={{ backgroundColor: c.surface, borderRadius: radius.xl, padding: space(6), borderWidth: 1, borderColor: c.line, gap: space(3), minHeight: 260 }}>
              <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name={item.icon} size={32} color={c.primary} />
              </View>
              <Text variant="title">{t(item.title)}</Text>
              <Text tone="muted">{t(item.body)}</Text>
              <View style={{ flexDirection: 'row', gap: space(2), marginTop: space(2) }}>
                {item.chips.map((ch: keyof typeof Ionicons.glyphMap) => (
                  <View key={ch} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons name={ch} size={19} color={c.inkSoft} />
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}
      />

      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: space(5), paddingBottom: insets.bottom + space(5), gap: space(5) }}>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
          {SLIDES.map((_, i) => (
            <View key={i} style={{ width: i === index ? 22 : 7, height: 7, borderRadius: 4, backgroundColor: i === index ? c.primary : c.line }} />
          ))}
        </View>
        <Button title={index < SLIDES.length - 1 ? t('continue') : t('getStarted')} icon="arrow-forward" iconPosition="right" onPress={next} loading={busy} />
      </View>
    </View>
  );
}
