require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# React Native / Expo pod for Snitch. Compiles the Swift core (ios/core, copied
# from ios/Sources/Snitch by scripts/sync-native-cores.mjs) together with the
# TurboModule (ios/RNSnitch.mm) and the launch-time autostart (ios/SNAutoStart.m).
# Depends only on React Native's local pods; nothing comes from CocoaPods trunk.
Pod::Spec.new do |s|
  s.name         = 'react-native-snitch'
  s.version      = package['version']
  s.summary      = 'Self-hosted bug reports with screenshot and screen video for React Native and Expo.'
  s.description  = package['description']
  s.homepage     = package['homepage']
  s.license      = { :type => package['license'], :file => 'LICENSE' }
  s.author       = package['author']
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => 'https://github.com/monjar/mobile-app-qa-sdk.git', :tag => "v#{s.version}" }

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  # The privacy manifest ships as a resource bundle; the source_files glob above
  # never matches it (an exclude_files entry would also strip it from the bundle).
  s.resource_bundles = { 'SnitchPrivacy' => ['ios/core/Resources/PrivacyInfo.xcprivacy'] }
  s.swift_version = '5.9'
  s.frameworks = 'UIKit', 'SwiftUI', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'ImageIO',
                 'ReplayKit', 'CoreMotion', 'StoreKit', 'Network', 'CryptoKit',
                 'CoreGraphics', 'CoreImage', 'QuartzCore'

  # Must be set before install_modules_dependencies, which merges into it.
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'GCC_PREPROCESSOR_DEFINITIONS' => "$(inherited) SNITCH_RN_VERSION=#{package['version']}",
  }

  if respond_to?(:install_modules_dependencies, true)
    # React Native >= 0.71: codegen (RNSnitchSpec), TurboModule and Folly settings.
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end
end
