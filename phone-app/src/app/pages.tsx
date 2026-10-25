import { StyleSheet, Text, View } from 'react-native';
import { Pressable } from '../motion';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Layers2 } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useStyles, useTheme, type Colors } from '../theme';

export default function PagesScreen() {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const router = useRouter();
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <View style={styles.content}>
      <Pressable style={styles.back} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back"><ArrowLeft size={17} color={colors.muted} /></Pressable>
      <Layers2 size={22} color={colors.muted} />
      <Text style={styles.title}>Deck pages</Text>
      <Text style={styles.body}>Pages and buttons are managed by the Open Dock desktop app and sync to this phone.</Text>
    </View>
  </SafeAreaView>;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, padding: 20, gap: 14, justifyContent: 'center' },
  back: { position: 'absolute', top: 12, left: 18, width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 6 },
  title: { color: colors.text, fontSize: 22, fontWeight: '600' },
  body: { color: colors.muted, fontSize: 12, lineHeight: 19 },
});
