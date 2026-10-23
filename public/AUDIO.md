# AUDIO

## BGM
- `assets/bgm/0054.mp3`：首页、房间等非对局循环 BGM
- `assets/bgm/0008.mp3`：对局循环 BGM
- `assets/bgm/0129.mp3`：场上有人报单/报双后的循环 BGM
- `assets/bgm/0037.mp3`：结算页 BGM

## 音效
- `sound-assets/`：P0 定稿音效
- 身份牌出现音效：旧版 `identity_landlord.wav`

## 声音设置
首页、房间、对局页均有音符按钮；二级弹窗可分别控制全局 / BGM / 音效的开关和音量。

首次进入会先播放加载动画，等待音频资源加载完成后再进入首页。浏览器对自动播放有策略限制，必要时点击一次页面即可解除静音限制。
