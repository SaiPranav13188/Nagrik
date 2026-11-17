import { Alert as RNAlert, Platform, type AlertButton } from 'react-native';

/**
 * React Native's Alert does nothing on web (the browser demo), so confirmation dialogs would
 * silently swallow taps like "Send escalation". On web this falls back to the browser's own
 * alert/confirm dialogs; on Android and iOS it is the normal native Alert.
 */
function webAlert(title: string, message?: string, buttons?: AlertButton[]) {
  const text = [title, message].filter(Boolean).join('\n\n');
  const actions = (buttons ?? []).filter((b) => b.style !== 'cancel');
  const cancel = (buttons ?? []).find((b) => b.style === 'cancel');
  if (actions.length <= 1 && (!buttons || buttons.length <= 1)) {
    window.alert(text);
    actions[0]?.onPress?.();
    return;
  }
  // One action: OK / Cancel. Several: offer them one at a time.
  for (const b of actions) {
    const question = actions.length === 1 ? text : `${text}\n\n${b.text}?`;
    if (window.confirm(question)) return b.onPress?.();
  }
  cancel?.onPress?.();
}

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]) {
    if (Platform.OS === 'web') webAlert(title, message, buttons);
    else RNAlert.alert(title, message, buttons);
  },
};
