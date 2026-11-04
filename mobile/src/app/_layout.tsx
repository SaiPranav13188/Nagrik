import 'react-native-url-polyfill/auto';
import React, { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, Text as RNText, View } from 'react-native';
import { Stack, router, usePathname, type ErrorBoundaryProps } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { AuthProvider, isProfileComplete, useAuth } from '../lib/auth';
import { I18nProvider, useI18n } from '../lib/i18n';
import { Button, Text } from '../components/ui';
import { onNotificationTap } from '../lib/notifications';
import { ToastProvider } from '../components/Toast';
import { useTheme } from '../theme';
import { installCrashReporter, reportError, setCrashScreen } from '../lib/crashReporter';

SplashScreen.preventAutoHideAsync().catch(() => {});
installCrashReporter();

/** Shown instead of a white screen when a screen crashes; the crash is reported. No providers here, so plain text in all 3 languages. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    reportError(error, { fatal: false, source: 'boundary' });
    SplashScreen.hideAsync().catch(() => {});
  }, [error]);
  return (
    <View style={{ flex: 1, backgroundColor: '#0F766E', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 }}>
      <RNText style={{ color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' }}>Something went wrong</RNText>
      <RNText style={{ color: '#D1FAE5', fontSize: 16, textAlign: 'center' }}>ఏదో పొరపాటు జరిగింది · कुछ गलत हो गया</RNText>
      <RNText style={{ color: '#D1FAE5', fontSize: 14, textAlign: 'center' }}>Your complaints are safe. This problem has been reported to us.</RNText>
      <Pressable onPress={retry} accessibilityRole="button" style={{ marginTop: 12, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 14, paddingHorizontal: 32 }}>
        <RNText style={{ color: '#0F766E', fontSize: 16, fontWeight: '700' }}>Try again · మళ్ళీ ప్రయత్నించండి · फिर से कोशिश करें</RNText>
      </Pressable>
    </View>
  );
}

function RootNavigator() {
  const { status, profile, profileError, refreshProfile, signOut } = useAuth();
  const { c, dark } = useTheme();
  const { t } = useI18n();
  const [retrying, setRetrying] = useState(false);
  const signedIn = status === 'signedIn';
  const ready = status !== 'loading' && (!signedIn || profile !== null || !!profileError);
  const complete = isProfileComplete(profile);
  const pathname = usePathname();
  useEffect(() => setCrashScreen(pathname), [pathname]);
  // The free server sleeps when idle and takes up to a minute to wake: say so instead of a blank splash.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    if (ready || slow) SplashScreen.hideAsync().catch(() => {});
  }, [ready, slow]);

  // Open the right complaint when a push notification is tapped.
  useEffect(() => {
    return onNotificationTap((id) => router.push(`/complaint/${id}`));
  }, []);

  if (!ready && slow) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0F766E', alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
        <ActivityIndicator size="large" color="#fff" />
        <Text variant="title" color="#fff" style={{ textAlign: 'center' }}>{t('wakingServer')}</Text>
        <Text color="#D1FAE5" style={{ textAlign: 'center' }}>{t('wakingServerBody')}</Text>
      </View>
    );
  }
  if (!ready) return <View style={{ flex: 1, backgroundColor: '#0F766E' }} />;

  // Signed in but the server couldn't be reached — offer a retry instead of hanging.
  if (signedIn && !profile && profileError) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
        <Ionicons name="cloud-offline-outline" size={48} color={c.muted} />
        <Text variant="title" style={{ textAlign: 'center' }}>{t('cantConnect')}</Text>
        <Text tone="muted" style={{ textAlign: 'center' }}>{profileError === 'NETWORK' ? t('cantConnectBody') : profileError}</Text>
        <Button
          title={t('retry')}
          icon="refresh"
          loading={retrying}
          style={{ alignSelf: 'stretch' }}
          onPress={async () => {
            setRetrying(true);
            await refreshProfile();
            setRetrying(false);
          }}
        />
        <Button title={t('signOut')} variant="ghost" onPress={() => void signOut()} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg }, animation: 'slide_from_right' }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="welcome" />
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && !complete}>
          <Stack.Screen name="profile-setup" />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && complete}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="report" options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="complaint/[id]" />
          <Stack.Screen name="edit-draft/[id]" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="help" />
          <Stack.Screen name="privacy" />
          <Stack.Screen name="notifications-setup" options={{ presentation: 'modal', animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  // If fonts fail to load, continue with system fonts rather than a blank screen.
  if (!fontsLoaded && !fontError) return null;
  return (
    <SafeAreaProvider>
      <KeyboardProvider statusBarTranslucent navigationBarTranslucent>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <RootNavigator />
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
