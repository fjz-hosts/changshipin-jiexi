Pod::Spec.new do |s|
  s.name = 'ChangshipinNative'
  s.version = '1.1.0'
  s.summary = '长视频解析手机端原生能力：本地取流代理、内置 WebView、嗅探与下载'
  s.homepage = 'https://github.com/fjz-hosts/changshipin-jiexi'
  s.license = { :type => 'MIT', :text => 'MIT License' }
  s.author = { 'fjz-hosts' => 'https://github.com/fjz-hosts' }
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/ChangshipinNative/**/*.{swift,h,m}'
  s.swift_version = '5.0'
  s.ios.deployment_target = '14.0'
  s.frameworks = 'UIKit', 'WebKit', 'Network'
  s.dependency 'Capacitor'
  s.dependency 'GCDWebServer', '~> 3.5'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
