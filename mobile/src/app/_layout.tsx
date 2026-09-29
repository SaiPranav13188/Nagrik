import 'react-native-url-polyfill/auto';
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts, Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { AuthProvider, isProfileComplete, useAuth } from '../lib/auth';
import { I18nProvider } from '../lib/i18n';
import { onNotificationTap } from '../lib/notifications';
import { ToastProvider } from '../components/Toast';
import { useTheme } from '../theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function RootNavigator() {
  const { status, profile } = useAuth();
  const { c, dark } = useTheme();
  const signedIn = status === 'signedIn';
  const ready = status !== 'loading' && (!signedIn || profile !== null);
  const complete = isProfileComplete(profile);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  // Open the right complaint when a push notification is tapped.
  useEffect(() => {
    return onNotificationTap((id) => router.push(`/complaint/${id}`));
  }, []);

  if (!ready) return <View style={{ flex: 1, backgroundColor: '#0F766E' }} />;

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
          <Stack.Screen name="notifications-setup" options={{ presentation: 'modal', animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AuthProvider>
          <ToastProvider>
            <RootNavigator />
          </ToastProvider>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
