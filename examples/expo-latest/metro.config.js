// Local development installs react-native-snitch from ../../react-native as a symlink (a
// `file:` dependency). Metro then has to watch that folder, and must not resolve react /
// react-native from its node_modules (the package's devDependencies), or the app would load
// two copies of React Native. CI installs the packed tarball instead: no symlink, no changes.
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const linked = path.join(projectRoot, 'node_modules', 'react-native-snitch');
if (fs.lstatSync(linked, { throwIfNoEntry: false })?.isSymbolicLink()) {
  const snitchRoot = fs.realpathSync(linked);
  const escape = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  config.watchFolders = [...(config.watchFolders ?? []), snitchRoot];
  config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
  config.resolver.blockList = [
    ...[].concat(config.resolver.blockList ?? []),
    new RegExp(`^${escape(path.join(snitchRoot, 'node_modules'))}[/\\\\].*`),
  ];
}

module.exports = config;
