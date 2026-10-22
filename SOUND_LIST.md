# A3 欢乐牌 · 音效清单

更新时间：2026-10-22

## 一、当前已有音效

目前没有外部音频文件，全部由 Web Audio 合成音 + 浏览器语音合成（TTS）实时生成。

| ID | 触发场景 | 当前实现 | 建议 |
| --- | --- | --- | --- |
| `turn` | 轮到我方出牌 / 开启音效试听 | 523Hz + 659Hz 双音 | 保留为“轮到你”，可换更清脆的铃铛 |
| `play` | 任意玩家出牌 | 659Hz + 880Hz 短音 | 建议换成纸牌落桌声 |
| `finish` | 有玩家出完手牌 | 440Hz + 587Hz 双音 | 保留“出完牌”提示 |
| `reveal` | 身份牌公开 / 翻身份 | 196/392/784Hz 三音 | 建议换成翻牌 + 身份揭示 |
| `landlord` | 我是地主 / 双地主 | 261/392/523Hz 三音 | 建议保留但加一点铜锣感 |
| `farmer` | 我是农民 | 392/523Hz 双音 | 建议保留但更轻快 |
| `report` | 报单 / 报双 | 1046/1318Hz 双音 | 建议换警铃“叮铃” |
| `win` | 结算胜利 | 392/494/587/784Hz 上行四音 | 建议换成完整胜利短乐句 |
| `error` | 操作错误 / 服务端报错 / 不能出牌 | 220Hz 方波 | 建议换成短促“嘟” |
| TTS | 出牌播报（`speakPlay`） | 浏览器中文语音播报牌型/牌 | 保留，可在设置中单独开关 |
| TTS | 身份播报（地主/农民/双地主） | 浏览器中文语音 | 保留 |
| TTS | 报单/报双播报 | 浏览器中文语音 | 保留 |

> 当前音效统一由 `playSound()` 合成；TTS 使用 `speechSynthesis`。音效开关只控制这些声音，不控制设备媒体音量。

## 二、建议补充的音效

优先级说明：P0 为必须体感；P1 为明显提升；P2 为可选氛围。

### 1. 牌局操作（P0）

| ID | 触发场景 | 时长建议 | 说明 |
| --- | --- | --- | --- |
| `deal` | 开局发牌 | 0.6–1.0s | 连续 13 张发牌的纸牌声，可循环 |
| `shuffle` | 洗牌 / 重开 | 0.8–1.2s | 洗牌摩擦声 |
| `select` | 点选手牌 | 0.06s | 轻微“嗒” |
| `deselect` | 取消选牌 | 0.06s | 更轻的“嗒” |
| `play_cards` | 出牌成功 | 0.25s | 纸牌甩到桌面 |
| `pass` | 过牌 | 0.2s | 轻“叩桌”声 |
| `auto_pass` | 托管/倒计时自动过牌 | 0.2s | 与手动过牌区分 |
| `trick_win` | 收轮 / 重新领出 | 0.3s | 收牌声 + 轻微上扬 |
| `invalid` | 选牌不合法 / 大不过 | 0.25s | 短促 Lower 提示 |
| `countdown_tick` | 最后 5 秒 | 0.12s | 每秒滴答，最后一秒加重 |
| `timeout` | 超时自动过牌 | 0.4s | 短提示，不刺耳 |

### 2. 身份与规则（P0/P1）

| ID | 触发场景 | 时长建议 | 说明 |
| --- | --- | --- | --- |
| `identity_reveal` | 身份牌公开 | 0.6s | 翻牌 + 金粉 |
| `landlord_confirm` | 地主确认 | 0.8s | 铜锣/低音重拍 |
| `farmer_confirm` | 农民确认 | 0.5s | 轻快双音 |
| `double_landlord` | 双地主确认 | 1.0s | 地主音效加强版 |
| `report_one` | 报单 | 0.7s | 单次警铃 |
| `report_two` | 报双 | 0.9s | 双次警铃 |
| `borrow_wind` | 借风触发 | 0.6s | 风声/轻扫弦 |
| `tribute_start` | 进入供牌 | 0.5s | 提示音 |
| `tribute_pick` | 挑走供牌 | 0.2s | 卡片滑动 |
| `tribute_send` | 进贡/还牌送出 | 0.3s | 卡片飞入 |
| `tribute_receive` | 收到供牌/还牌 | 0.3s | 卡片落桌 |
| `tribute_done` | 供牌阶段结束 | 0.5s | 完成提示 |

### 3. 结算与积分（P0/P1）

| ID | 触发场景 | 时长建议 | 说明 |
| --- | --- | --- | --- |
| `result_open` | 结算面板弹出 | 0.4s | 金框展开 |
| `win_round` | 本局胜利 | 1.2–1.8s | 短胜利乐句 |
| `lose_round` | 本局失败 | 1.0–1.5s | 低沉下行 |
| `draw_round` | 平局 | 0.8s | 中性收束 |
| `score_up` | 个人积分增加 | 0.4s | 金币/上扬音 |
| `score_down` | 个人积分减少 | 0.4s | 下沉音 |
| `restart` | 再来一把 | 0.3s | 按钮确认 |

### 4. 房间与社交（P1/P2）

| ID | 触发场景 | 时长建议 | 说明 |
| --- | --- | --- | --- |
| `join_room` | 加入房间成功 | 0.4s | 门铃/入座 |
| `leave_room` | 离开房间 | 0.3s | 门合上 |
| `player_ready` | 玩家准备 | 0.2s | 轻点头 |
| `kick` | 踢出玩家 | 0.5s | 明确但不过分 |
| `copy_ok` | 复制房间号/链接 | 0.15s | 轻提示 |
| `click` | 通用按钮点击 | 0.05s | 很轻，避免疲劳 |
| `modal_open` | 弹窗打开 | 0.2s | 纸张/轻扫 |
| `modal_close` | 弹窗关闭 | 0.15s | 反向轻扫 |
| `chat_pop` | 表情气泡出现 | 0.15s | “啵” |
| `gift_menu` | 菜篮子打开 | 0.2s | 篮子轻响 |
| `flower_fly` | 送花飞行 | 0.7s | 可跟随 0.75s 飞行 |
| `flower_bloom` | 鲜花盛开 | 1.0s | 花开音 |
| `egg_fly` | 砸蛋飞行 | 0.7s | 加速呼啸 |
| `egg_smash` | 鸡蛋破碎 | 0.8s | 破碎 + 流液 |
| `trust_on` | 开启托管 | 0.3s | 机械/自动提示 |
| `trust_off` | 取消托管 | 0.2s | 反向提示 |
| `connect` | 连接成功 | 0.3s | 轻上线 |
| `disconnect` | 断线 | 0.5s | 提示但不吓人 |

### 5. 教程与引导（P1/P2）

| ID | 触发场景 | 时长建议 | 说明 |
| --- | --- | --- | --- |
| `tutorial_step` | 教程进入下一步 | 0.2s | 轻进度音 |
| `tutorial_correct` | 教程操作正确 | 0.4s | 上扬确认 |
| `tutorial_wrong` | 教程操作错误 | 0.3s | 温和纠错 |
| `tutorial_gate` | 基础教程完成 | 0.7s | 小成就 |
| `tutorial_finish` | 教程完成 | 1.0s | 完成乐句 |

### 6. 可选的氛围/音乐（P2）

| ID | 场景 | 说明 |
| --- | --- | --- |
| `ambience_table` | 牌桌环境底噪 | 极低音量循环，默认关闭 |
| `music_lobby` | 首页/房间轻音乐 | 30–60s 循环，可单独开关 |
| `music_result` | 结算短音乐 | 3–5s，不循环 |

## 三、音频格式与实现建议

- 格式：优先 `.ogg`（Opus）+ `.mp3` 回退；单声道，44.1kHz。
- 命名：`sfx_<id>.ogg`，例如 `sfx_play_cards.ogg`、`sfx_egg_smash.ogg`。
- 常用音效预加载；长音频按需加载。
- 所有音效统一走 `SFX` 管理器：音量总线、静音、避免同一声效短时间内叠加超过 2 次。
- 建议把音效分为「操作」「牌桌」「社交」「结算」四条总线，分别可调音量。
- 设备系统音量不可由网页修改；网页只能调整自身输出增益。当前已把合成音整体增益提高约 4 倍，并把 TTS 设到浏览器上限；如果仍偏小，建议后续接入响度更高的真实音频素材。
- 音乐/环境声默认关闭，避免打扰；音效默认开启，可由用户关闭。

## 四、当前建议第一批先做

1. `deal` / `shuffle`
2. `select` / `deselect` / `play_cards` / `pass` / `invalid`
3. `turn` / `countdown_tick` / `timeout`
4. `identity_reveal` / `landlord_confirm` / `farmer_confirm` / `report_one` / `report_two`
5. `tribute_start` / `tribute_pick` / `tribute_send` / `tribute_receive` / `tribute_done`
6. `result_open` / `win_round` / `lose_round` / `score_up` / `score_down`
7. `flower_fly` / `flower_bloom` / `egg_fly` / `egg_smash`
