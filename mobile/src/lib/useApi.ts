import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * Tiny data hook: loads on focus, optional polling while `pollMs` is set,
 * refreshes when the app returns to the foreground. Keeps the last good data on errors.
 */
export function useApi<T>(fetcher: () => Promise<T>, opts: { pollMs?: number | null; deps?: unknown[] } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(true);

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent' = 'silent') => {
    if (mode === 'refresh') setRefreshing(true);
    try {
      const d = await fetcherRef.current();
      if (!mounted.current) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load('initial'), opts.deps ?? []);

  useFocusEffect(
    useCallback(() => {
      void load('silent');
    }, [load]),
  );

  useEffect(() => {
    if (!opts.pollMs) return;
    const id = setInterval(() => void load('silent'), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, load]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void load('silent');
    });
    return () => sub.remove();
  }, [load]);

  return { data, setData, error, loading, refreshing, refresh: () => load('refresh'), reload: () => load('silent') };
}
