---
media: "./【高画質・完全版】春日さくらと乾夏寧の夏もさくらを咲かせたい 第49回.mp4"
title: "【高画質・完全版】春日さくらと乾夏寧の夏もさくらを咲かせたい 第49回"
url: "https://www.nicovideo.jp/watch/so46390977"
published_at: "2026/6/3"
---

## Context

- Source/uploader: NicoNico, exact uploader/channel not confirmed from local metadata.
- User notes: Translate this video into Simplified Chinese subtitles. The rajio project, skill, and translation flow are still under development; review the skill and CLI workflow while executing.
- Video synopsis: Japanese talk/radio style video featuring 春日さくら and 乾夏寧. Episode topics include hair treatment, natto mixing, live/event impressions, listener mail about cheering oneself up, useful goods, a lyric-improvisation corner, and announcements.
- Cast/speakers: 春日さくら, 乾夏寧. ASR speaker labels are not reliable enough to map globally without audio/video review.

## Glossary And Fixed Terms

- 春日さくら -> 春日樱
- 乾夏寧 -> 乾夏宁
- 春日さくらと乾夏寧の夏もさくらを咲かせたい -> 春日樱与乾夏宁的《也想让夏天绽放樱花》
- 夏もさくらを咲かせたい -> 也想让夏天绽放樱花
- 夏さく -> 夏樱
- 夏さく咲く -> 夏樱绽放
- 第49回 -> 第49回
- 前橋ウィッチーズ -> 前桥魔女
- ハッシュタグ夏さく咲く -> 话题标签「夏樱绽放」
- ゴー☆レボ / ごーれぼ -> Go☆Revo
- 新宿村LIVE -> 新宿村 LIVE
- 夏さくプレゼンツ 乾夏寧バースデーイベント2026 -> 夏樱绽放 presents 乾夏宁 Birthday Event 2026
- 塚田悠衣 -> 塚田悠衣
- 月城日花 -> 月城日花
- 花谷麻妃 -> 花谷麻妃
- 小森結梨 -> 小森结梨
- 茶屋町推しフェスティバル2026 -> 茶屋町推し Festival 2026
- 星陵会館 -> 星陵会馆
- 高円寺Studio K -> 高圆寺 Studio K
- オムニバス朗読「だい研6」 -> 综合朗读《だい研6》
- セカンドショットチャンネル -> Second Shot Channel
- natsusaku@secondshot.jp -> natsusaku@secondshot.jp
- Common ASR confusion: 犬井/犬井夏音/乾夏音 -> 乾夏寧
- Common ASR confusion: みんなつね/めんなツネ/ナチュ -> 乾夏寧 or なっつー depending on context

## Fixed Subtitle Phrases

- Program main title: 春日樱与乾夏宁的《也想让夏天绽放樱花》
- Program short title: 夏樱绽放
- 皆さん、咲いてますか -> 大家开花了吗
- かすがさん、いぬいさん、咲いてますか -> 春日樱 乾夏宁 开花了吗
- かすがさん、いぬいさん、こんばんは、咲いてますか -> 春日樱 乾夏宁 晚上好 开花了吗
- こんばんは、春日さくらです -> 晚上好 我是春日樱
- こんばんは、乾夏寧です -> 晚上好 我是乾夏宁
- お便り -> 来信
- メールテーマ -> 来信主题
- 夏さくネーム / 夏サクネーム -> 夏樱名
- ハッシュタグ夏さく咲く -> 话题标签「夏樱绽放」
- 番組では皆さんからのお便りをお待ちしております -> 节目正在等待大家来信
- 番組の感想や私たちが聞きたいことなど気軽にお送りください -> 节目感想或想问我们的事都欢迎轻松寄来
- たくさんのお便りお待ちしております -> 期待大家踊跃来信
- エンディングのお時間です -> 到这里进入片尾时间
- お相手は春日さくらと、乾夏寧でした -> 本期主持是春日樱和乾夏宁
- またね -> 再见
- Host honorifics: when さん/ちゃん refers to 春日さくら or 乾夏寧, prefer the host names
  春日樱 / 乾夏宁 instead of transliterating the honorific as 桑/酱.
- Listener/poster さん: omit the honorific in Chinese; use the name directly, not 桑.
- Guest/person さん: generally omit 桑 as well; preserve ちゃん as 酱 only when the friendly
  conversational tone is important.
- Listener names that are nickname-like, e.g. ほっぺまー, ロシアンカボチャ, ひたくち,
  ごじろ, and みっちー, should generally be preserved in the original form rather than
  romanized.

## Style Requirements

- Translate into natural Simplified Chinese subtitles.
- Preserve speaker tone, banter, jokes, and recurring phrases.
- Keep names and title terminology consistent with the glossary unless the transcript proves a different official rendering.
- Prefer concise subtitle phrasing over literal word-by-word translation.

## QA Notes From This Session

- `transcript_work` and `translation_work` were force-committed because the remaining blocking
  errors were inherited Japanese subtitle QA heuristics: long Japanese lines and Japanese reading
  speed. No empty text, schema, invalid timing, overlap, or untranslated Chinese errors remained.
- The CLI-generated ASR segmentation created many 0 ms adjacent gaps. These were normalized to
  90 ms gaps before committing; many soft `subtitle_gap_short` warnings remain.
- Chinese hard errors were fixed before export. Remaining Chinese issues are soft warnings only.
- Segment `2-47` remains transcript-uncertain: ASR has `作本なんじゅうさいてますか`; the attempted
  correction `特報されてますか` was rejected as unreliable.
- Some ASR/special terms remain uncertain and were preserved conservatively: `アサベル丼`,
  `デートウォーズ`, `已己巳己 巳己`, and `Go☆Jas` / `ゴー☆ジャス`.
- The ending sign-off is split by the source segmentation into separate subtitles:
  `本期主持是春日樱和` / `乾夏宁`. It is readable but could be merged in a later timing pass.
