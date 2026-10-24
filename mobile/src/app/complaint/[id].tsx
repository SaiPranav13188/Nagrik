import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Share, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, Card, Divider, IconBubble, Input, Pill, PulseDot, Skeleton, Text } from '../../components/ui';
import { ActivityTimeline, ProgressTracker, StatusPill } from '../../components/complaint';
import { ResidentsPill } from '../../components/community';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api, errorMessage } from '../../lib/api';
import { resolveMediaUrl } from '../../lib/config';
import { formatDateTime, issueMeta, relativeTime } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { ComplaintDetail } from '../../lib/types';
import { useApi } from '../../lib/useApi';
import { radius, space, useTheme } from '../../theme';

const RECHECK_DAYS = 3;
const RETRYABLE = ['portal_error', 'navigation_failed', 'selector_mismatch', 'missing_citizen_details', 'awaiting_confirmation'];

export default function ComplaintScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [letterOpen, setLetterOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  const q = useApi(() => api.complaint(id), { deps: [id] });
  const d = q.data;
  const s = d?.complaint.status;
  const fast = s === 'analyzing' || s === 'submitting' || (s === 'drafted' && !!d?.complaint.submit_after);
  useEffect(() => {
    const iv = setInterval(() => void q.reload(), fast ? 2000 : 20000);
    return () => clearInterval(iv);
  }, [fast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-time aligned countdown for the non-blocking review window.
  const skew = useMemo(() => (d ? new Date(d.server_time).getTime() - Date.now() : 0), [d?.server_time]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!d?.complaint.submit_after) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [d?.complaint.submit_after]);
  const secondsLeft = d?.complaint.submit_after ? Math.max(0, Math.ceil((new Date(d.complaint.submit_after).getTime() - (now + skew)) / 1000)) : null;

  const act = async (key: string, fn: () => Promise<ComplaintDetail | void>, success?: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r) q.setData(r);
      if (success) toast(success, 'success');
    } catch (e) {
      toast(errorMessage(e, t('offline'), t('somethingWrong')), 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    toast(t('copied'), 'success');
  };
  const openUrl = (url: string) => WebBrowser.openBrowserAsync(resolveMediaUrl(url) ?? url).catch(() => Linking.openURL(url));

  if (!d) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top }}>
        {q.error ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(3) }}>
            <Ionicons name="cloud-offline-outline" size={36} color={c.muted} />
            <Text tone="muted" style={{ textAlign: 'center' }}>{errorMessage(q.error, t('offline'), t('somethingWrong'))}</Text>
            <Button title={t('retry')} variant="secondary" size="md" onPress={q.refresh} />
            <Button title={t('back')} variant="ghost" size="md" onPress={() => router.back()} />
          </View>
        ) : (
          <View style={{ padding: space(4), gap: space(4) }}>
            <Skeleton height={260} style={{ borderRadius: radius.xl }} />
            <Skeleton width="60%" height={24} />
            <Skeleton width="90%" />
            <Skeleton height={120} style={{ borderRadius: radius.lg }} />
          </View>
        )}
      </View>
    );
  }

  const cmp = d.complaint;
  const meta = issueMeta(cmp.issue_type);
  const j = d.jurisdiction;
  const letter = cmp.draft_text ? `${cmp.draft_subject ? `Subject: ${cmp.draft_subject}\n\n` : ''}${cmp.draft_text}` : null;
  const pendingEscalation = d.escalations.find((e) => e.delivery_status !== 'sent');
  const lastCheck = cmp.last_checked_at ?? cmp.submitted_at;
  const nextCheckDays = lastCheck ? Math.max(0, Math.ceil(RECHECK_DAYS - (Date.now() - new Date(lastCheck).getTime()) / 86400000)) : RECHECK_DAYS;
  const portalUrl = j?.portal_url ?? null;
  const isOwner = d.viewer_role !== 'supporter';
  const electrical = cmp.issue_type === 'streetlight' && /wire|live|shock|current|spark/i.test(`${cmp.description} ${cmp.user_note ?? ''}`);
  const showEmergency = cmp.severity === 'high' && cmp.status !== 'resolved';
  // Asking right after filing is noise; ask once the department has had a day, or after an escalation.
  const askIfFixed = s === 'escalated' || (!!cmp.submitted_at && Date.now() - new Date(cmp.submitted_at).getTime() > 86400000);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + space(10) }}
        refreshControl={<RefreshControl refreshing={q.refreshing} onRefresh={q.refresh} tintColor={c.primary} colors={[c.primary]} />}
      >
        {/* Hero */}
        <View style={{ height: 300 }}>
          <Image source={resolveMediaUrl(cmp.photo_url) ?? undefined} style={{ width: '100%', height: '100%', backgroundColor: c.surfaceAlt }} contentFit="cover" transition={250} accessibilityLabel={t(meta.key)} />
          <LinearGradient colors={['rgba(0,0,0,0.55)', 'transparent', 'rgba(0,0,0,0.65)']} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
          <View style={{ position: 'absolute', top: insets.top + space(2), left: space(4), right: space(4), flexDirection: 'row', justifyContent: 'space-between' }}>
            <Pressable onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} accessibilityLabel={t('back')} hitSlop={8} style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="arrow-back" size={22} color="#fff" />
            </Pressable>
            {letter && (
              <Pressable onPress={() => Share.share({ message: letter })} accessibilityLabel={t('share')} hitSlop={8} style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="share-outline" size={21} color="#fff" />
              </Pressable>
            )}
          </View>
          <View style={{ position: 'absolute', left: space(5), right: space(5), bottom: space(9), gap: space(2) }}>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <StatusPill complaint={cmp} />
              <ResidentsPill supporters={cmp.supporters_count ?? 0} />
            </View>
            <Text variant="title" color="#fff">{t(meta.key)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="location" size={14} color="rgba(255,255,255,0.85)" />
              <Text variant="small" color="rgba(255,255,255,0.9)" numberOfLines={2} style={{ flex: 1 }}>{cmp.address}</Text>
            </View>
          </View>
        </View>

        <View style={{ marginTop: -space(6), backgroundColor: c.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: space(4), gap: space(4) }}>
          <Card>
            <ProgressTracker complaint={cmp} />
          </Card>

          {!isOwner && (
            <Card style={{ gap: space(3) }}>
              <View style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}>
                <IconBubble name="hand-right" color={c.info} bg={c.infoSoft} />
                <Text variant="small" tone="soft" style={{ flex: 1 }}>{t('supporterView')}</Text>
              </View>
              <Button
                title={t('removeSupport')}
                variant="ghost"
                size="sm"
                loading={busy === 'unsupport'}
                onPress={() =>
                  act('unsupport', async () => {
                    await api.unsupport(cmp.id);
                    router.back();
                  })
                }
              />
            </Card>
          )}

          {showEmergency && (
            <Card style={{ gap: space(3), borderColor: c.danger, borderWidth: 1.5 }}>
              <View style={{ flexDirection: 'row', gap: space(3) }}>
                <IconBubble name="warning" color={c.danger} bg={c.dangerSoft} />
                <View style={{ flex: 1 }}>
                  <Text variant="heading">{t('emergencyTitle')}</Text>
                  <Text variant="small" tone="muted">{t('emergencyBody')}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: space(2) }}>
                <Button title={t('call112')} variant="danger" size="md" icon="call" style={{ flex: 1 }} onPress={() => Linking.openURL('tel:112')} />
                {(electrical || cmp.issue_type === 'streetlight') && (
                  <Button title={t('call1912')} variant="secondary" size="md" icon="flash" style={{ flex: 1 }} onPress={() => Linking.openURL('tel:1912')} />
                )}
              </View>
            </Card>
          )}

          {/* ─────────── Contextual action card ─────────── */}
          {s === 'analyzing' && (
            <Card style={{ gap: space(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                <PulseDot color={c.primary} />
                <Text variant="heading">{t('agentsWorking')}</Text>
              </View>
              <Text tone="muted">{t('agentsWorkingBody')}</Text>
              <ActivityTimeline items={d.activity.slice(-4)} live />
            </Card>
          )}

          {isOwner && s === 'drafted' && secondsLeft !== null && (
            <Card style={{ gap: space(3), borderColor: c.primary, borderWidth: 1.5 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
                <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 3, borderColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
                  <Text variant="heading" tone="primary">{secondsLeft}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{t('filingIn', { dept: j?.department_name?.split('–')[0]?.trim() ?? '', s: secondsLeft })}</Text>
                  <Text variant="small" tone="muted">{t('filingInBody')}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: space(2) }}>
                <Button title={t('holdReview')} variant="secondary" icon="pause" size="md" style={{ flex: 1 }} loading={busy === 'hold'} onPress={() => act('hold', () => api.hold(cmp.id))} />
                <Button title={t('submitNow')} icon="paper-plane" size="md" style={{ flex: 1 }} loading={busy === 'submit'} onPress={() => act('submit', () => api.submit(cmp.id))} />
              </View>
            </Card>
          )}

          {isOwner && s === 'drafted' && secondsLeft === null && (
            <Card style={{ gap: space(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
                <IconBubble name="document-text" color={c.info} bg={c.infoSoft} />
                <View style={{ flex: 1 }}>
                  <Text variant="heading">{t('readyToFile')}</Text>
                  <Text variant="small" tone="muted">{t('readyToFileBody')}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: space(2) }}>
                <Button title={t('edit')} variant="secondary" icon="create-outline" size="md" style={{ flex: 1 }} onPress={() => router.push(`/edit-draft/${cmp.id}`)} />
                <Button title={t('submitNow')} icon="paper-plane" size="md" style={{ flex: 1.4 }} loading={busy === 'submit'} onPress={() => act('submit', () => api.submit(cmp.id))} />
              </View>
            </Card>
          )}

          {s === 'submitting' && (
            <Card style={{ gap: space(2) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                <PulseDot color={c.primary} />
                <Text variant="heading">{t('filingNow')}</Text>
              </View>
              <Text tone="muted">{t('filingNowBody')}</Text>
            </Card>
          )}

          {isOwner && s === 'submission_failed' && (
            <Card style={{ gap: space(4), borderColor: c.warning, borderWidth: 1.5 }}>
              <View style={{ flexDirection: 'row', gap: space(3) }}>
                <IconBubble name="hand-left" color={c.warning} bg={c.warningSoft} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="heading">{d.failure?.category === 'missing_citizen_details' ? t('updateProfile') : t('finishTitle')}</Text>
                  <Text variant="small" tone="muted">{d.failure?.message}</Text>
                </View>
              </View>
              {d.failure?.category === 'missing_citizen_details' ? (
                <View style={{ flexDirection: 'row', gap: space(2) }}>
                  <Button title={t('updateProfile')} variant="secondary" size="md" style={{ flex: 1 }} onPress={() => router.navigate('/profile')} />
                  <Button title={t('retry')} size="md" style={{ flex: 1 }} loading={busy === 'retry'} onPress={() => act('retry', () => api.retry(cmp.id))} />
                </View>
              ) : (
                <>
                  {[
                    { n: 1, label: t('finishStep1'), action: letter ? <Button title={t('copy')} size="sm" variant="secondary" icon="copy-outline" onPress={() => copy(letter)} /> : null },
                    { n: 2, label: t('finishStep2'), action: portalUrl ? <Button title={t('openPortal')} size="sm" variant="secondary" icon="open-outline" onPress={() => openUrl(portalUrl)} /> : null },
                    { n: 3, label: t('finishStep3'), action: <Button title={t('done')} size="sm" icon="checkmark" onPress={() => setManualOpen(true)} /> },
                  ].map((step) => (
                    <View key={step.n} style={{ flexDirection: 'row', alignItems: 'center', gap: space(3) }}>
                      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                        <Text variant="smallStrong">{step.n}</Text>
                      </View>
                      <Text variant="bodyStrong" style={{ flex: 1 }}>{step.label}</Text>
                      {step.action}
                    </View>
                  ))}
                  {j?.notes && /OTP|WhatsApp/i.test(j.notes) && (
                    <View style={{ backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: space(3), flexDirection: 'row', gap: space(2) }}>
                      <Ionicons name="information-circle-outline" size={18} color={c.muted} />
                      <Text variant="small" tone="muted" style={{ flex: 1 }}>{j.notes.match(/Live portal requires[^.]*\.[^.]*\./)?.[0] ?? ''}</Text>
                    </View>
                  )}
                  {d.failure && RETRYABLE.includes(d.failure.category) && (
                    <Button title={t('retryAuto')} variant="ghost" size="md" icon="refresh" loading={busy === 'retry'} onPress={() => act('retry', () => api.retry(cmp.id))} />
                  )}
                </>
              )}
            </Card>
          )}

          {(s === 'submitted' || s === 'escalated') && (
            <Card style={{ gap: space(4) }}>
              <View style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}>
                <IconBubble name={s === 'escalated' ? 'trending-up' : 'checkmark-done'} color={s === 'escalated' ? c.danger : c.primary} bg={s === 'escalated' ? c.dangerSoft : c.primarySoft} />
                <View style={{ flex: 1 }}>
                  <Text variant="heading">{s === 'escalated' ? t('escalatedTitle') : t('filedTitle')}</Text>
                  <Text variant="small" tone="muted">{cmp.portal_status ? `“${cmp.portal_status}”` : ''} {cmp.submitted_at ? `· ${relativeTime(cmp.submitted_at, t)}` : ''}</Text>
                </View>
              </View>
              {cmp.tracking_id && (
                <Pressable onPress={() => copy(cmp.tracking_id!)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: c.surfaceAlt, borderRadius: radius.md, padding: space(3) }}>
                  <View>
                    <Text variant="caption" tone="muted">{t('reference')}</Text>
                    <Text variant="heading" selectable>{cmp.tracking_id}</Text>
                  </View>
                  <Ionicons name="copy-outline" size={20} color={c.primary} />
                </Pressable>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                <Ionicons name="time-outline" size={16} color={c.muted} />
                <Text variant="small" tone="muted" style={{ flex: 1 }}>{t('nextCheck', { when: nextCheckDays ? t('inDays', { n: nextCheckDays }) : t('today') })}</Text>
                {isOwner && (
                  <Pressable onPress={() => act('check', () => api.checkStatus(cmp.id))} disabled={busy === 'check'} hitSlop={8}>
                    <Text variant="smallStrong" tone="primary">{busy === 'check' ? t('loading') : t('checkNow')}</Text>
                  </Pressable>
                )}
              </View>
              {isOwner && askIfFixed && (
                <>
                  <Divider />
                  <Text variant="bodyStrong">{t('isItFixed')}</Text>
                  <View style={{ flexDirection: 'row', gap: space(2) }}>
                    <Button title={t('notYet')} variant="secondary" size="md" style={{ flex: 1 }} loading={busy === 'no'} onPress={() => act('no', () => api.userStatus(cmp.id, false))} />
                    <Button title={t('yesFixed')} size="md" icon="checkmark" style={{ flex: 1 }} loading={busy === 'yes'} onPress={() => act('yes', () => api.userStatus(cmp.id, true), t('resolvedTitle'))} />
                  </View>
                </>
              )}
            </Card>
          )}

          {isOwner && pendingEscalation && s === 'escalated' && (
            <Card style={{ gap: space(3), borderColor: c.warning, borderWidth: 1.5 }}>
              <View style={{ flexDirection: 'row', gap: space(3) }}>
                <IconBubble name="mail-unread" color={c.warning} bg={c.warningSoft} />
                <View style={{ flex: 1 }}>
                  <Text variant="heading">{t('escalationReady')}</Text>
                  <Text variant="small" tone="muted">{t('escalationReadyBody')}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: space(2) }}>
                {pendingEscalation.draft_text && <Button title={t('copy')} variant="secondary" size="md" icon="copy-outline" style={{ flex: 1 }} onPress={() => copy(pendingEscalation.draft_text!)} />}
                {pendingEscalation.channel === 'email' && pendingEscalation.recipient ? (
                  <Button
                    title={t('sendEmail')}
                    size="md"
                    icon="mail-outline"
                    style={{ flex: 1 }}
                    onPress={() => {
                      const [subject, ...body] = (pendingEscalation.draft_text ?? '').split('\n\n');
                      Linking.openURL(`mailto:${pendingEscalation.recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.join('\n\n'))}`);
                    }}
                  />
                ) : pendingEscalation.recipient ? (
                  <Button title={t('openPortal')} size="md" icon="open-outline" style={{ flex: 1 }} onPress={() => openUrl(pendingEscalation.recipient!)} />
                ) : null}
              </View>
            </Card>
          )}

          {s === 'resolved' && (
            <Card style={{ alignItems: 'center', gap: space(2), paddingVertical: space(6), backgroundColor: c.successSoft, borderColor: c.successSoft }}>
              <Ionicons name="trophy" size={40} color={c.success} />
              <Text variant="title">{t('resolvedTitle')}</Text>
              <Text tone="soft" style={{ textAlign: 'center' }}>{t('resolvedBody')}</Text>
            </Card>
          )}

          {/* ─────────── Department ─────────── */}
          {j && (
            <Card style={{ gap: space(3) }}>
              <Text variant="caption" tone="muted">{t('department')}</Text>
              <View style={{ flexDirection: 'row', gap: space(3), alignItems: 'center' }}>
                <IconBubble name="business" color={c.primary} bg={c.primarySoft} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Text variant="bodyStrong">{j.department_name}</Text>
                  <View style={{ flexDirection: 'row', gap: space(1.5), flexWrap: 'wrap' }}>
                    <Pill size="sm" label={j.verified ? t('verified') : t('unverified')} icon={j.verified ? 'shield-checkmark' : 'hourglass-outline'} fg={j.verified ? c.success : c.warning} bg={j.verified ? c.successSoft : c.warningSoft} />
                    {j.is_sandbox && <Pill size="sm" label={t('sandbox')} icon="flask-outline" fg={c.info} bg={c.infoSoft} />}
                  </View>
                </View>
              </View>
              <Pressable onPress={() => openUrl(j.portal_url)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="globe-outline" size={15} color={c.primary} />
                <Text variant="small" tone="primary" numberOfLines={1} style={{ flex: 1 }}>{j.portal_url.replace(/^https?:\/\//, '')}</Text>
              </Pressable>
            </Card>
          )}

          {/* ─────────── Complaint letter ─────────── */}
          {letter && (
            <Card style={{ gap: space(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="caption" tone="muted">{t('complaintLetter')}</Text>
                <View style={{ flexDirection: 'row', gap: space(4) }}>
                  {['drafted', 'submission_failed'].includes(cmp.status) && (
                    <Pressable onPress={() => router.push(`/edit-draft/${cmp.id}`)} hitSlop={8} accessibilityLabel={t('edit')}>
                      <Ionicons name="create-outline" size={20} color={c.primary} />
                    </Pressable>
                  )}
                  <Pressable onPress={() => copy(letter)} hitSlop={8} accessibilityLabel={t('copy')}>
                    <Ionicons name="copy-outline" size={20} color={c.primary} />
                  </Pressable>
                </View>
              </View>
              {cmp.draft_subject && <Text variant="bodyStrong">{cmp.draft_subject}</Text>}
              <Text variant="small" tone="soft" numberOfLines={letterOpen ? undefined : 7} selectable>{cmp.draft_text}</Text>
              <Pressable onPress={() => setLetterOpen((v) => !v)} hitSlop={8}>
                <Text variant="smallStrong" tone="primary">{letterOpen ? t('showLess') : t('showMore')}</Text>
              </Pressable>
            </Card>
          )}

          {/* ─────────── Agent activity ─────────── */}
          {d.activity.length > 0 && s !== 'analyzing' && (
            <Card style={{ gap: space(3) }}>
              <Pressable onPress={() => setActivityOpen((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }} accessibilityRole="button">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space(2) }}>
                  <Ionicons name="sparkles" size={16} color={c.primary} />
                  <Text variant="bodyStrong">{t('agentActivity')}</Text>
                  <Text variant="small" tone="faint">({d.activity.length})</Text>
                </View>
                <Ionicons name={activityOpen ? 'chevron-up' : 'chevron-down'} size={20} color={c.muted} />
              </Pressable>
              {activityOpen && <ActivityTimeline items={d.activity} live={s === 'submitting'} />}
            </Card>
          )}

          {/* ─────────── Status history ─────────── */}
          {d.status_checks.length > 0 && (
            <Card style={{ gap: space(3) }}>
              <Text variant="caption" tone="muted">{t('statusHistory')}</Text>
              {d.status_checks.slice(0, 6).map((sc) => (
                <View key={sc.id} style={{ flexDirection: 'row', gap: space(3) }}>
                  <Ionicons name={sc.source === 'scraped' ? 'globe-outline' : 'person-outline'} size={16} color={c.muted} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1 }}>
                    <Text variant="small">{sc.status_found}</Text>
                    <Text variant="small" tone="faint" style={{ fontSize: 11 }}>{formatDateTime(sc.checked_at)}</Text>
                  </View>
                </View>
              ))}
            </Card>
          )}

          {d.escalations.length > 0 && (
            <Card style={{ gap: space(3) }}>
              <Text variant="caption" tone="muted">{t('escalations')}</Text>
              {d.escalations.map((e) => (
                <View key={e.id} style={{ flexDirection: 'row', gap: space(3) }}>
                  <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: c.dangerSoft, alignItems: 'center', justifyContent: 'center' }}>
                    <Text variant="smallStrong" color={c.danger}>{e.escalation_level}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="small">{e.action_taken}</Text>
                    <Text variant="small" tone="faint" style={{ fontSize: 11 }}>{formatDateTime(e.created_at)}</Text>
                  </View>
                </View>
              ))}
            </Card>
          )}

          {isOwner && ['analyzing', 'drafted', 'submission_failed'].includes(cmp.status) && (
            <Button
              title={t('withdraw')}
              variant="ghost"
              icon="trash-outline"
              size="md"
              style={{ alignSelf: 'center' }}
              onPress={() =>
                Alert.alert(t('withdraw'), t('withdrawConfirm'), [
                  { text: t('cancel'), style: 'cancel' },
                  {
                    text: t('withdraw'),
                    style: 'destructive',
                    onPress: () =>
                      act('del', async () => {
                        await api.remove(cmp.id);
                        router.back();
                      }),
                  },
                ])
              }
            />
          )}
          <Text variant="small" tone="faint" style={{ textAlign: 'center' }}>#{cmp.id.slice(0, 8)} · {formatDateTime(cmp.created_at)}</Text>
        </View>
      </ScrollView>

      <Sheet visible={manualOpen} onClose={() => setManualOpen(false)}>
        <View style={{ gap: space(4) }}>
          <Text variant="title">{t('iSubmitted')}</Text>
          <Input placeholder={t('referencePlaceholder')} value={reference} onChangeText={setReference} autoCapitalize="characters" icon="receipt-outline" />
          <Button
            title={t('done')}
            icon="checkmark"
            loading={busy === 'manual'}
            onPress={() =>
              act('manual', async () => {
                const r = await api.manualSubmitted(cmp.id, reference.trim());
                setManualOpen(false);
                return r;
              }, t('filedTitle'))
            }
          />
        </View>
      </Sheet>
    </View>
  );
}
