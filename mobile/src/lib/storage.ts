import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/** Secure storage on device, AsyncStorage on web (SecureStore isn't available there). */
export const secure = {
  async get(key: string) {
    try {
      return Platform.OS === 'web' ? await AsyncStorage.getItem(key) : await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string) {
    try {
      if (Platform.OS === 'web') await AsyncStorage.setItem(key, value);
      else await SecureStore.setItemAsync(key, value);
    } catch {}
  },
  async remove(key: string) {
    try {
      if (Platform.OS === 'web') await AsyncStorage.removeItem(key);
      else await SecureStore.deleteItemAsync(key);
    } catch {}
  },
};

export const prefs = {
  get: (k: string) => AsyncStorage.getItem(k).catch(() => null),
  set: (k: string, v: string) => AsyncStorage.setItem(k, v).catch(() => {}),
  remove: (k: string) => AsyncStorage.removeItem(k).catch(() => {}),
};
