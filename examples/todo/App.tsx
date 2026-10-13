/**
 * A small todo app with Snitch in it, used for the screenshots in the docs and blog posts.
 *
 * - Tap a row to tick it; the app saves that with a PATCH. The save URL has a typo on purpose
 *   (/todo/ instead of /todos/), so the server answers 404, the app logs a warning and rolls the
 *   tick back. That is the bug a tester reports, and the report's timeline shows why.
 * - Hold a row for 600 ms to delete it, with no confirmation: the kind of action Snitch's
 *   three-finger hold must never set off.
 * - The "Add a todo" field is an editable TextInput, so Snitch masks it in screenshots and video.
 * - Snitch is set up by the config plugin in app.json (captureNetwork on); the only Snitch call
 *   here is setScreen, so the timeline names "Today" and "Done".
 *
 * Launched with `-demo story` (iOS launch argument, read through Settings), the app plays a short
 * scripted session on its own so CI can take screenshots without touching the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Settings, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import { Snitch } from 'react-native-snitch';

const API = 'https://jsonplaceholder.typicode.com';

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

type Tab = 'Today' | 'Done';

const SEED: Todo[] = [
  { id: 1, title: 'Water the plants', done: true },
  { id: 2, title: 'Reply to Sam about Saturday', done: false },
  { id: 3, title: 'Buy oat milk', done: false },
  { id: 4, title: 'Call the bank', done: false },
  { id: 5, title: 'Fix the bike light', done: true },
];

const demoMode = (): string | null => {
  if (Platform.OS !== 'ios') return null;
  const value: unknown = Settings.get('demo');
  return typeof value === 'string' ? value : null;
};

export default function App() {
  const dark = useColorScheme() === 'dark';
  const c = dark
    ? { bg: '#000', fg: '#f2f2f7', card: '#1c1c1e', muted: '#8e8e93', line: '#2c2c2e', accent: '#30d158', warn: '#ff453a', warnBg: '#3a1512' }
    : { bg: '#f2f2f7', fg: '#111', card: '#fff', muted: '#6c6c70', line: '#e5e5ea', accent: '#248a3d', warn: '#d70015', warnBg: '#ffe5e3' };

  const [todos, setTodos] = useState<Todo[]>(SEED);
  const [tab, setTab] = useState<Tab>('Today');
  const [owner, setOwner] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const nextId = useRef(SEED.length + 1);

  // Who the list belongs to: one GET, so the timeline has a request that worked.
  useEffect(() => {
    fetch(`${API}/users/1`)
      .then((r) => r.json())
      .then((user: { name?: string }) => {
        const first = user.name?.split(' ')[0] ?? null;
        setOwner(first);
        console.log(`loaded user ${first ?? '?'}`);
      })
      .catch((error: unknown) => console.warn(`could not load the user: ${String(error)}`));
  }, []);

  useEffect(() => {
    Snitch.setScreen(tab);
  }, [tab]);

  const add = useCallback((title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const todo = { id: nextId.current++, title: trimmed, done: false };
    setTodos((list) => [...list, todo]);
    setDraft('');
    console.log(`added "${trimmed}"`);
  }, []);

  const toggle = useCallback((todo: Todo) => {
    const done = !todo.done;
    setProblem(null);
    setTodos((list) => list.map((t) => (t.id === todo.id ? { ...t, done } : t)));
    // The bug: /todo/ should be /todos/.
    fetch(`${API}/todo/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ completed: done }),
    })
      .then((r) => {
        if (r.ok) return;
        console.warn(`save failed: PATCH /todo/${todo.id} → ${r.status}, rolling back`);
        setTodos((list) => list.map((t) => (t.id === todo.id ? { ...t, done: !done } : t)));
        setProblem(`Couldn't save "${todo.title}". Try again.`);
      })
      .catch((error: unknown) => console.warn(`save failed: ${String(error)}`));
  }, []);

  const remove = useCallback((todo: Todo) => {
    setTodos((list) => list.filter((t) => t.id !== todo.id));
    console.log(`deleted "${todo.title}"`);
  }, []);

  // `-demo story`: a few seconds of someone using the app, then (in CI) Snitch's debug autoreport.
  const latest = useRef({ todos, add, toggle });
  latest.current = { todos, add, toggle };
  useEffect(() => {
    if (demoMode() !== 'story') return;
    const steps: [number, () => void][] = [
      [2500, () => setTab('Done')],
      [3500, () => setTab('Today')],
      [4500, () => latest.current.add('Book the dentist')],
      [6000, () => {
        const milk = latest.current.todos.find((t) => t.id === 3);
        if (milk) latest.current.toggle(milk);
      }],
    ];
    const timers = steps.map(([ms, step]) => setTimeout(step, ms));
    return () => timers.forEach(clearTimeout);
  }, []);

  const shown = todos.filter((t) => (tab === 'Done' ? t.done : !t.done));
  const doneCount = todos.filter((t) => t.done).length;

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: c.fg }]}>{owner ? `${owner}'s list` : 'My list'}</Text>
        <Text style={[styles.subtitle, { color: c.muted }]}>
          {doneCount} of {todos.length} done
        </Text>

        <View style={[styles.tabs, { backgroundColor: c.line }]}>
          {(['Today', 'Done'] as const).map((name) => (
            <Pressable
              key={name}
              onPress={() => setTab(name)}
              style={[styles.tab, tab === name && { backgroundColor: c.card }]}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === name }}
            >
              <Text style={[styles.tabText, { color: c.fg }]}>{name}</Text>
            </Pressable>
          ))}
        </View>

        {problem ? (
          <View style={[styles.banner, { backgroundColor: c.warnBg }]}>
            <Text style={{ color: c.warn }}>{problem}</Text>
          </View>
        ) : null}

        <View style={[styles.card, { backgroundColor: c.card }]}>
          {shown.length === 0 ? (
            <Text style={[styles.empty, { color: c.muted }]}>{tab === 'Done' ? 'Nothing done yet.' : 'All done. Nice.'}</Text>
          ) : (
            shown.map((todo, i) => (
              <Pressable
                key={todo.id}
                onPress={() => toggle(todo)}
                onLongPress={() => remove(todo)}
                delayLongPress={600}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
                  pressed && { opacity: 0.6 },
                ]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: todo.done }}
                accessibilityHint="Hold to delete"
              >
                <View style={[styles.check, { borderColor: todo.done ? c.accent : c.muted }, todo.done && { backgroundColor: c.accent }]}>
                  {todo.done ? <Text style={styles.tick}>✓</Text> : null}
                </View>
                <Text style={[styles.rowText, { color: todo.done ? c.muted : c.fg }, todo.done && styles.struck]}>{todo.title}</Text>
              </Pressable>
            ))
          )}
        </View>

        <View style={styles.addRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => add(draft)}
            placeholder="Add a todo"
            placeholderTextColor={c.muted}
            returnKeyType="done"
            style={[styles.input, { color: c.fg, backgroundColor: c.card }]}
          />
          <Pressable onPress={() => add(draft)} style={[styles.addButton, { backgroundColor: c.accent }]} accessibilityRole="button">
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>

        <Text style={[styles.hint, { color: c.muted }]}>Tap to tick, hold to delete.</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 72, paddingBottom: 32, gap: 14 },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 15, marginTop: -8 },
  tabs: { flexDirection: 'row', borderRadius: 9, padding: 2 },
  tab: { flex: 1, paddingVertical: 7, borderRadius: 7, alignItems: 'center' },
  tabText: { fontSize: 14, fontWeight: '600' },
  banner: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
  card: { borderRadius: 12, overflow: 'hidden' },
  empty: { padding: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#fff', fontSize: 14, fontWeight: '700' },
  rowText: { fontSize: 17, flexShrink: 1 },
  struck: { textDecorationLine: 'line-through' },
  addRow: { flexDirection: 'row', gap: 10 },
  input: { flex: 1, height: 46, borderRadius: 10, paddingHorizontal: 14, fontSize: 17 },
  addButton: { height: 46, borderRadius: 10, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 13, textAlign: 'center' },
});
