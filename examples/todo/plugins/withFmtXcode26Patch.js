// Copied from mochiro-mobile (plugins/withFmtXcode26Patch.js). React Native 0.76 apps need it
// to build with Xcode 26; it only edits the Podfile's post_install hook, which
// react-native-snitch's own config plugin never touches. Keep it registered last in app.json.
//
/**
 * Makes the Xcode 26 fmt patch survive `expo prebuild --clean`.
 *
 * RN 0.76's vendored fmt 11.0.2 force-enables FMT_USE_CONSTEVAL for the clang
 * shipped with Xcode 26, which then rejects fmt's FMT_STRING constructors
 * ("call to consteval function … is not a constant expression"). The macro is
 * set unconditionally in Pods/fmt/include/fmt/base.h, so a -D flag can't win —
 * the header itself has to be edited. Pods/ is regenerated on every clean
 * prebuild/pod install, so this plugin injects the edit into the Podfile's
 * post_install hook, where it re-applies after each install.
 */
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const MARKER = '# mochiro: fmt Xcode 26 consteval patch';

// Ruby, run inside `post_install do |installer|`. The sub! anchor only exists
// in the unpatched header (patching rewrites `#if` to `#elif`), so this is
// idempotent across repeated `pod install` runs.
const RUBY_SNIPPET = `    ${MARKER}
    fmt_base = File.join(__dir__, 'Pods', 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      s = File.read(fmt_base)
      if s.sub!("#if !defined(__cpp_lib_is_constant_evaluated)",
                "#if 1 // mochiro: consteval is broken in Xcode 26 clang\\n#  define FMT_USE_CONSTEVAL 0\\n#elif !defined(__cpp_lib_is_constant_evaluated)")
        File.write(fmt_base, s)
      end
    end
`;

module.exports = function withFmtXcode26Patch(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfile, 'utf8');
      if (!contents.includes(MARKER)) {
        const anchor = 'post_install do |installer|';
        if (!contents.includes(anchor)) {
          throw new Error('withFmtXcode26Patch: Podfile has no post_install block to hook');
        }
        contents = contents.replace(anchor, `${anchor}\n${RUBY_SNIPPET}`);
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);
};
