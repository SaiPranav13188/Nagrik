import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { api, configureApi } from './api';
import { SUPABASE_ANON_KEY, SUPABASE_URL, USE_SUPABASE_AUTH } from './config';
import { prefs, secure } from './storage';
import type { Profile } from './types';

const TOKEN_KEY = 'nagrik.localToken';
const DEVICE_KEY = 'nagrik.deviceId';

export const supabase: SupabaseClient | null = USE_SUPABASE_AUTH
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    })
  : null;

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  profile: Profile | null;
  mode: 'supabase' | 'local';
  refreshProfile: () => Promise<Profile | null>;
  setProfile: (p: Profile) => void;
  startLocalSession: () => Promise<void>;
  sendEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function isProfileComplete(p: Profile | null) {
  return !!(p?.full_name && p.phone);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [profile, setProfile] = useState<Profile | null>(null);
  const localToken = useRef<string | null>(null);

  const getToken = useCallback(async () => {
    if (supabase) {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    }
    return localToken.current;
  }, []);

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut().catch(() => {});
    localToken.current = null;
    await secure.remove(TOKEN_KEY);
    setProfile(null);
    setStatus('signedOut');
  }, []);

  useEffect(() => {
    configureApi({ getToken, onUnauthorized: () => void signOut() });
  }, [getToken, signOut]);

  const refreshProfile = useCallback(async () => {
    try {
      const { profile } = await api.me();
      setProfile(profile);
      return profile;
    } catch {
      return null;
    }
  }, []);

  // Restore session on launch.
  useEffect(() => {
    (async () => {
      if (supabase) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          setStatus('signedIn');
          void refreshProfile();
        } else setStatus('signedOut');
        supabase.auth.onAuthStateChange((_e, session) => {
          if (!session) {
            setStatus('signedOut');
            setProfile(null);
          }
        });
        return;
      }
      const t = await secure.get(TOKEN_KEY);
      if (t) {
        localToken.current = t;
        setStatus('signedIn');
        void refreshProfile();
      } else setStatus('signedOut');
    })();
  }, [refreshProfile]);

  const startLocalSession = useCallback(async () => {
    let deviceId = await secure.get(DEVICE_KEY);
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      await secure.set(DEVICE_KEY, deviceId);
    }
    const r = await api.localSignIn(deviceId);
    localToken.current = r.token;
    await secure.set(TOKEN_KEY, r.token);
    setProfile(r.profile);
    setStatus('signedIn');
  }, []);

  const sendEmailCode = useCallback(async (email: string) => {
    if (!supabase) throw new Error('Email sign-in is not configured');
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) throw error;
  }, []);

  const verifyEmailCode = useCallback(
    async (email: string, code: string) => {
      if (!supabase) throw new Error('Email sign-in is not configured');
      const { error } = await supabase.auth.verifyOtp({ email, token: code, type: 'email' });
      if (error) throw error;
      setStatus('signedIn');
      const p = await refreshProfile();
      if (p && !p.email) {
        const { profile } = await api.updateMe({ email });
        setProfile(profile);
      }
    },
    [refreshProfile],
  );

  const value = useMemo<AuthValue>(
    () => ({
      status,
      profile,
      mode: supabase ? 'supabase' : 'local',
      refreshProfile,
      setProfile,
      startLocalSession,
      sendEmailCode,
      verifyEmailCode,
      signOut,
    }),
    [status, profile, refreshProfile, startLocalSession, sendEmailCode, verifyEmailCode, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export const onboardingFlags = {
  welcomeSeen: () => prefs.get('nagrik.welcomeSeen').then((v) => v === '1'),
  setWelcomeSeen: () => prefs.set('nagrik.welcomeSeen', '1'),
  notifAsked: () => prefs.get('nagrik.notifAsked').then((v) => v === '1'),
  setNotifAsked: () => prefs.set('nagrik.notifAsked', '1'),
};
