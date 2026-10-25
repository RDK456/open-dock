import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Pressable } from './motion';
import { usePcConnection, type DeckAction, type DeckButton, type DeckMediaCommand, type DeckPlacement, type SystemCommand } from './connection';
import { useStyles, useTheme, type Colors } from './theme';

/** What the editor works on: an existing button, or an empty cell to fill. */
export type EditTarget = { pageId: string; folderId?: string; button?: DeckButton; placement: DeckPlacement };

type Kind = 'media' | 'hotkey' | 'type_text' | 'open_url' | 'system';

// The PC accepts only these from a phone (see phone_editable in lib.rs); the rest are set up on the PC.
const EDITABLE = new Set<DeckAction['type']>(['media', 'hotkey', 'type_text', 'open_url', 'system', 'select_page', 'select_profile']);
const KINDS: [Kind, string][] = [['media', 'Media'], ['hotkey', 'Shortcut'], ['type_text', 'Type text'], ['open_url', 'Website'], ['system', 'System']];
const MEDIA: [DeckMediaCommand, string][] = [['play_pause', 'Play / Pause'], ['next_track', 'Next'], ['previous_track', 'Previous'], ['volume_up', 'Volume up'], ['volume_down', 'Volume down'], ['mute', 'Mute']];
const SYSTEM: [SystemCommand, string][] = [['screenshot', 'Screenshot'], ['lock', 'Lock'], ['sleep', 'Sleep'], ['brightness_up', 'Brightness up'], ['brightness_down', 'Brightness down']];

/** Adds, changes or removes one deck button from the phone; the PC saves it and every device updates. */
export function ButtonEditor({ target, onClose }: { target: EditTarget; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const { editButton } = usePcConnection();
  const action = target.button?.action;
  const editable = !action || EDITABLE.has(action.type);
  const [label, setLabel] = useState(target.button?.label ?? '');
  const [kind, setKind] = useState<Kind>(action && KINDS.some(([value]) => value === action.type) ? action.type as Kind : 'hotkey');
  const [media, setMedia] = useState<DeckMediaCommand>(action?.type === 'media' ? action.command : 'play_pause');
  const [keys, setKeys] = useState(action?.type === 'hotkey' ? action.keys.join('+') : '');
  const [text, setText] = useState(action?.type === 'type_text' ? action.text : '');
  const [url, setUrl] = useState(action?.type === 'open_url' ? action.url : 'https://');
  const [system, setSystem] = useState<SystemCommand>(action?.type === 'system' ? action.command : 'screenshot');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const build = (): DeckAction | string => {
    if (kind === 'media') return { type: 'media', command: media };
    if (kind === 'system') return { type: 'system', command: system };
    if (kind === 'type_text') return text.trim() ? { type: 'type_text', text } : 'Enter the text to type';
    if (kind === 'open_url') return /^https?:\/\/\S+$/i.test(url.trim()) ? { type: 'open_url', url: url.trim() } : 'Enter a web address starting with https://';
    const parts = keys.toUpperCase().split('+').map((key) => key.trim()).filter(Boolean);
    return parts.length >= 2 ? { type: 'hotkey', keys: parts } : 'Enter a shortcut such as CTRL+C';
  };
  const fallbackLabel = () => kind === 'media' ? MEDIA.find(([value]) => value === media)![1] : kind === 'system' ? SYSTEM.find(([value]) => value === system)![1] : kind === 'hotkey' ? keys.toUpperCase() : kind === 'open_url' ? url.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0] : text;

  const run = async (edit: { button?: DeckButton; removeId?: string }) => {
    setBusy(true);
    setError('');
    const failure = await editButton({ pageId: target.pageId, folderId: target.folderId, ...edit });
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  const save = () => {
    const next = build();
    if (typeof next === 'string') return setError(next);
    const name = (label.trim() || fallbackLabel().trim()).slice(0, 24) || 'Button';
    void run({ button: { id: target.button?.id ?? `phone-${Date.now().toString(36)}`, label: name, icon: 'auto', placement: target.placement, action: next } });
  };

  const chips = <T extends string>(items: [T, string][], value: T, onPick: (next: T) => void) => <View style={styles.chips}>
    {items.map(([item, name]) => <Pressable key={item} onPress={() => onPick(item)} style={[styles.chip, item === value && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: item === value }}><Text style={[styles.chipText, item === value && styles.chipTextOn]}>{name}</Text></Pressable>)}
  </View>;

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close editor" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <Text style={styles.title}>{target.button ? 'Edit button' : 'New button'}</Text>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {editable ? <>
            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={label} onChangeText={setLabel} maxLength={24} placeholder={fallbackLabel() || 'Button name'} placeholderTextColor={colors.faint} />
            <Text style={styles.label}>Does</Text>
            {chips(KINDS, kind, setKind)}
            {kind === 'media' ? chips(MEDIA, media, setMedia) : null}
            {kind === 'system' ? chips(SYSTEM, system, setSystem) : null}
            {kind === 'hotkey' ? <TextInput style={styles.input} value={keys} onChangeText={setKeys} autoCapitalize="characters" autoCorrect={false} placeholder="CTRL+SHIFT+M" placeholderTextColor={colors.faint} /> : null}
            {kind === 'type_text' ? <TextInput style={[styles.input, styles.multiline]} value={text} onChangeText={setText} multiline maxLength={2000} placeholder="Text the PC types where the cursor is" placeholderTextColor={colors.faint} /> : null}
            {kind === 'open_url' ? <TextInput style={styles.input} value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://" placeholderTextColor={colors.faint} /> : null}
          </> : <Text style={styles.note}>{target.button?.label} opens apps, files, scripts or plugins. Change it in Open Dock on the PC.</Text>}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>
        <View style={styles.actions}>
          {target.button && action?.type !== 'open_folder' ? <Pressable style={[styles.button, styles.danger]} disabled={busy} onPress={() => void run({ removeId: target.button!.id })} accessibilityRole="button"><Text style={[styles.buttonText, styles.dangerText]}>Delete</Text></Pressable> : null}
          <Pressable style={styles.button} disabled={busy} onPress={onClose} accessibilityRole="button"><Text style={styles.buttonText}>Cancel</Text></Pressable>
          {editable ? <Pressable style={[styles.button, styles.primary, busy && styles.disabled]} disabled={busy} onPress={save} accessibilityRole="button"><Text style={[styles.buttonText, styles.primaryText]}>{busy ? 'Saving…' : 'Save'}</Text></Pressable> : null}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: { maxHeight: '82%', paddingHorizontal: 18, paddingBottom: 22, borderTopLeftRadius: 26, borderTopRightRadius: 26, backgroundColor: colors.panelRaised, borderWidth: 1, borderColor: colors.glassBorder },
  grabber: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, marginTop: 9, marginBottom: 12, backgroundColor: colors.borderStrong },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 6 },
  body: { gap: 10, paddingVertical: 6 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600', marginTop: 4 },
  input: { minHeight: 46, borderRadius: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass, color: colors.text, fontSize: 16 },
  multiline: { minHeight: 96, paddingTop: 12, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '500' },
  chipTextOn: { color: colors.onAccent },
  note: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  error: { color: colors.red, fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: { flex: 1, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.glass },
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  danger: { borderColor: colors.red },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  primaryText: { color: colors.onAccent },
  dangerText: { color: colors.red },
  disabled: { opacity: 0.5 },
});
