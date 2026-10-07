/**
 * Snitch example: one screen with the things a report must get right.
 *
 * - Long-press rows (Pressable, delayLongPress 600): when the three-finger gesture fires,
 *   Snitch cancels the touch, so "longPress" must not increase while "pressOut" does.
 * - A two-pointer RNGH pan: a Snitch gesture cancels it, which shows up as "panCancelled".
 * - A Skia canvas animated by Reanimated: Metal content that must appear in the video.
 * - A TextInput (masked: editable) and a view with testID "snitch-mask-demo" (masked by testID).
 * - "Report" opens the sheet from JavaScript.
 */
import { Canvas, Circle, Fill } from '@shopify/react-native-skia';
import { useEffect, useState } from 'react';
import { Button, FlatList, Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Easing, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Snitch } from 'react-native-snitch';

const ROWS = ['Row 1', 'Row 2', 'Row 3', 'Row 4', 'Row 5'];
const CANVAS_HEIGHT = 120;

export default function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark
    ? { bg: '#000', fg: '#f2f2f7', card: '#1c1c1e', muted: '#8e8e93' }
    : { bg: '#f2f2f7', fg: '#111', card: '#fff', muted: '#6c6c70' };

  const [longPresses, setLongPresses] = useState(0);
  const [pressOuts, setPressOuts] = useState(0);
  const [panCancelled, setPanCancelled] = useState(0);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setStatus(`releaseType: ${Snitch.releaseType()} · enabled: ${String(Snitch.isEnabled())}`);
  }, []);

  const pan = Gesture.Pan()
    .maxPointers(2)
    .runOnJS(true)
    .onFinalize((_event, success) => {
      if (!success) setPanCancelled((n) => n + 1);
    });

  const cx = useSharedValue(30);
  useEffect(() => {
    if (canvasWidth <= 60) return;
    cx.value = 30;
    cx.value = withRepeat(withTiming(canvasWidth - 30, { duration: 1500, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [canvasWidth, cx]);

  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.fg }]}>Snitch example</Text>
        <Text style={[styles.caption, { color: colors.muted }]} testID="snitch-status">
          {status}
        </Text>

        <View style={styles.counters}>
          <Text style={[styles.counter, { color: colors.fg }]} testID="longpress-count">
            longPress: {longPresses}
          </Text>
          <Text style={[styles.counter, { color: colors.fg }]} testID="pressout-count">
            pressOut: {pressOuts}
          </Text>
          <Text style={[styles.counter, { color: colors.fg }]} testID="pancancelled-count">
            panCancelled: {panCancelled}
          </Text>
        </View>

        <FlatList
          data={ROWS}
          keyExtractor={(item) => item}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <Pressable
              testID={`row-${item}`}
              delayLongPress={600}
              onLongPress={() => setLongPresses((n) => n + 1)}
              onPressOut={() => setPressOuts((n) => n + 1)}
              style={({ pressed }) => [styles.row, { backgroundColor: colors.card, opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={{ color: colors.fg }}>{item} · hold to long-press</Text>
            </Pressable>
          )}
        />

        <GestureDetector gesture={pan}>
          <View style={[styles.panArea, { backgroundColor: colors.card }]} testID="pan-area">
            <Text style={{ color: colors.muted }}>Pan here (one or two fingers)</Text>
          </View>
        </GestureDetector>

        <View style={styles.canvasBox} onLayout={(e) => setCanvasWidth(e.nativeEvent.layout.width)}>
          <Canvas style={styles.canvas}>
            <Fill color={colors.card} />
            <Circle cx={cx} cy={CANVAS_HEIGHT / 2} r={24} color="#ff375f" />
          </Canvas>
        </View>

        <TextInput
          testID="secret"
          placeholder="Secret (masked: editable text input)"
          placeholderTextColor={colors.muted}
          style={[styles.input, { color: colors.fg, backgroundColor: colors.card }]}
        />

        <View testID="snitch-mask-demo" style={[styles.masked, { backgroundColor: colors.card }]}>
          <Text style={{ color: colors.fg }}>masked by testID</Text>
        </View>

        <Button title="Report" onPress={() => Snitch.show()} />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 16, paddingTop: 64, paddingBottom: 24, gap: 10 },
  title: { fontSize: 22, fontWeight: '600' },
  caption: { fontSize: 12 },
  counters: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  counter: { fontSize: 15, fontVariant: ['tabular-nums'] },
  row: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, marginBottom: 6 },
  panArea: { height: 70, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  canvasBox: { height: CANVAS_HEIGHT, borderRadius: 10, overflow: 'hidden' },
  canvas: { flex: 1 },
  input: { height: 44, borderRadius: 10, paddingHorizontal: 12 },
  masked: { padding: 12, borderRadius: 10 },
});
