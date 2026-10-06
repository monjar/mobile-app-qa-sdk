// Autolinking hints (React Native CLI and Expo autolinking). The Android namespace is
// io.github.monjar.snitch (the core's package), while the React Native package class lives
// in io.github.monjar.snitch.rn, so the import can't be derived from the namespace.
// iOS needs nothing here: react-native-snitch.podspec is found automatically.
module.exports = {
  dependency: {
    platforms: {
      android: {
        packageImportPath: 'import io.github.monjar.snitch.rn.SnitchPackage;',
        packageInstance: 'new SnitchPackage()',
      },
    },
  },
};
