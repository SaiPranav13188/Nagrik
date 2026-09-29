import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import { api } from './api';
import { EAS_PROJECT_ID } from './config';

/**
 * expo-notifications throws at import time inside Expo Go on Android (remote push was removed
 * from Expo Go in SDK 53). So it is loaded lazily, and only where it is supported: development
 * builds, production builds, and iOS Expo Go. Everywhere else the app relies on in-app Updates.
 */
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
export const pushSupported = Platform.OS !== 'web' && !(isExpoGo && Platform.OS === 'android');

type NotificationsModule = typeof import('expo-notifications');
let mod: NotificationsModule | null | undefined;

function load(): NotificationsModule | null {
  if (mod !== undefined) return mod;
  if (!pushSupported) return (mod = null);
  try {
    mod = require('expo-notifications') as NotificationsModule;
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch {
    mod = null;
  }
  return mod;
}

export async function notificationPermission(): Promise<'granted' | 'denied' | 'undetermined' | 'unsupported'> {
  const N = load();
  if (!N) return 'unsupported';
  try {
    return (await N.getPermissionsAsync()).status;
  } catch {
    return 'undetermined';
  }
}

/** Asks for permission and registers the Expo push token with the backend. */
export async function enableNotifications(): Promise<boolean> {
  const N = load();
  if (!N) return false;
  try {
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync('complaint-updates', {
        name: 'Complaint updates',
        importance: N.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 120, 200],
        lightColor: '#0F766E',
      });
    }
    let { status } = await N.getPermissionsAsync();
    if (status !== 'granted') status = (await N.requestPermissionsAsync()).status;
    if (status !== 'granted') return false;
    if (Device.isDevice && EAS_PROJECT_ID) {
      const token = await N.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
      await api.setPushToken(token.data);
    }
    return true;
  } catch {
    return false;
  }
}

/** Calls `onOpen(complaintId)` when the user taps a notification. Returns an unsubscribe function. */
export function onNotificationTap(onOpen: (complaintId: string) => void): () => void {
  const N = load();
  if (!N) return () => {};
  const sub = N.addNotificationResponseReceivedListener((r) => {
    const id = (r.notification.request.content.data as { complaintId?: string } | undefined)?.complaintId;
    if (id) onOpen(id);
  });
  return () => sub.remove();
}
