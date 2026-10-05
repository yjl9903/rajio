# 视频画面截取工具

状态：已实现。调研与实现日期：2026-10-06。

## 目标与实现

让 Agent 在字幕校对、翻译和资料整理时，按需查看原视频画面，例如屏幕上的姓名、
题板、物品以及动作语境。新增独立命令 `rajio frames <target>`，提供指定时间点截图
和区间均匀抽帧。复用现有 FFmpeg/ffprobe，不新增运行时依赖或工作流阶段。

用户已确认首版覆盖指定时间点截图和区间均匀抽帧；整段缩略图总览不在本次范围内。

## 仓库现状

- `src/audio/index.ts` 已有 `probeMediaMetadata()`，通过 ffprobe 读取容器和流信息。
- `src/utils/env.ts` 已支持 `FFMPEG_PATH`、`FFPROBE_PATH` 和 cwd/session `.env` 加载。
- `src/clips/` 用于时间区间的音频重转录，含 ASR、检查点和 clip 元数据；不适合承载截图。
- `Session.load()` 在已有 session 中可只读解析媒体，仍执行精确版本匹配。
  缺少 session 时不会自动解析传入的视频文件，不能直接用于独立视频截图。
- `docs/plan/004`、`008`、`028`、`029` 分别约定辅助工具、路径、session 版本和 CLI 帮助。

## 首版命令

已实现的命令接口：

```bash
# 指定一个或多个时间点，单位为源媒体起点之后的秒数
rajio frames /path/to/session --at 123.45 --json
rajio frames /path/to/video.mp4 --at 120,123.45,126 --json

# 在区间内均匀取 6 个点，每个子区间取中点
rajio frames /path/to/session --start 120 --end 150 --count 6 --json
```

- `--at` 与 `--start/--end/--count` 互斥；区间模式必须同时提供三个参数。
- 时间仅接受有限、非负的十进制秒数（允许小数点及周围空白，不接受指数、十六进制、
  正负号、空项）；首版不增加时间码语法或按字幕 ID 取帧。
- `end > start`，`count` 为整数。每次最多 24 张，时间点模式按去重后的数量采用同样上限。
- 区间采样公式为 `start + (i + 0.5) * (end - start) / count`，`i = 0..count-1`。
  上例请求 122.5、127.5、132.5、137.5、142.5、147.5 秒，避免直接采样区间末端。
- `--at` 使用单个逗号分隔参数，保持输入顺序；重复时间点去重。内部不通过帧率推算帧号，支持可变帧率来源。
- 首版输出原始显示尺寸的 PNG，保留 FFmpeg 默认旋转处理；非方形像素需要转换为
  等效显示比例的方形像素图片。暂不增加格式、质量、裁剪、拼图等选项。

## 输入、输出与状态

输入分两类，规则写入命令帮助：

1. 现有 session 目录或 `session.toml`：先确认 session 存在，再调用 `Session.load()`，
   使用记录的媒体。遵循现有版本校验，不保存 session，不触发媒体变化检查或阶段重置。
2. 独立本地媒体文件：直接使用该文件，不依赖或创建其同目录的 session。
   首版不额外支持 description markdown、远程 URL、`--media` 覆盖或目录自动发现。

使用已有 runtime 配置加载逻辑；独立媒体模式以媒体父目录作为配置加载的第二个目录。
无需 ASR API key，不调用 ASR 或视觉模型。图片由调用方使用自身图像查看能力读取。

图片固定保存到目标根目录下的 `frames/`，不提供自定义输出目录参数，也不使用系统临时
目录：session 输入使用 session 根目录；独立媒体输入使用媒体文件父目录，与 cwd 无关。
每次调用在 `frames/` 内创建 `capture-<随机后缀>/`，成功后保留，结构如下：

```text
<session 或媒体父目录>/
  frames/
    capture-<随机后缀>/
      frame-001.png
      frame-002.png
```

每次重新生成，不缓存，不覆盖已有图片，也不新增 manifest、frames list/show 或清理命令。

输出文件为 `frame-001.png` 等；使用顺序名，不把请求时间伪装成图片的真实 PTS。
具体输出格式见下节。首版不提供未经测量的 `actual_seconds`。

全批成功才返回成功结果。失败时删除本次创建的子目录，返回非零退出码，并指出失败的
请求时间及原因。失败清理只作用于本次 `capture-<随机后缀>/`，保留 `frames/` 及其他批次。

## 命令输出约定

### 输出模式与通道

| 条件 | stdout | stderr | 退出码 |
| --- | --- | --- | --- |
| 成功，指定 `--json` | 一个 JSON 对象 | 通常为空 | 0 |
| 成功，未指定 `--json`，stdout 为 TTY | 人类可读表格 | 通常为空 | 0 |
| 成功，未指定 `--json`，stdout 非 TTY | 带表头的 CSV | 通常为空 | 0 |
| 参数、输入、探测、截帧或文件写入失败 | 空 | 文本错误信息 | 1 |

`--json` 优先于 TTY 判断。所有成功输出末尾有一个换行；JSON 在 TTY 下采用两空格缩进，
非 TTY 下为单行紧凑 JSON。stdout 只输出完整结果，不混入进度、FFmpeg 日志或成功提示。
如需显示诊断信息，统一写入 stderr；不直接透传 FFmpeg 的常规进度输出。
首版不提供 JSON 错误对象，指定 `--json` 的调用方同样先根据退出码判断成功与否。

### JSON 字段与示例

调用示例：

```bash
rajio frames /work/episode --at 120,123.45 --json
```

成功输出如下，随机目录名仅作示例：

```json
{
  "output_dir": "/work/episode/frames/capture-a1b2c3",
  "frames": [
    {
      "time": 120,
      "path": "/work/episode/frames/capture-a1b2c3/frame-001.png"
    },
    {
      "time": 123.45,
      "path": "/work/episode/frames/capture-a1b2c3/frame-002.png"
    }
  ]
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `output_dir` | string | 本次调用实际创建的 `capture-<随机后缀>/` 绝对路径 |
| `frames` | array | 本次成功生成的全部图片，顺序与请求点一致 |
| `frames[].time` | number | 实际传给截帧操作的请求秒数，相对源媒体起点，不是实际帧 PTS |
| `frames[].path` | string | 已生成且非空的 PNG 绝对路径，可直接交给图像查看工具 |

以上字段均必填，不返回 null。图片数量使用 `frames.length`，不增加重复的计数字段。
JSON 返回路径和请求时间，不返回图片二进制、base64 或 Markdown 图片标签。

两种取帧模式返回完全相同的结构：`--at` 按输入顺序去重后逐项返回；区间模式按时间
递增返回 `count` 项。比如 `--start 120 --end 150 --count 6` 的 `time`
依次为 `122.5, 127.5, 132.5, 137.5, 142.5, 147.5`，对应 `frame-001.png` 至
`frame-006.png`。不添加模式专属字段，也不把区间端点作为图片行返回。

### 默认 TTY 输出

同一请求去掉 `--json` 后，交互终端显示：

```text
Output directory: /work/episode/frames/capture-a1b2c3

TIME    PATH
------  -----------------------------------------------
120     /work/episode/frames/capture-a1b2c3/frame-001.png
123.45  /work/episode/frames/capture-a1b2c3/frame-002.png
```

表格按内容宽度对齐，不截断路径。时间显示十进制秒数，不取整或转成损失精度的时间码。
表格仅用于人类阅读；程序使用 JSON 或 CSV。

### 默认非 TTY 输出

重定向或通过管道调用、且没有指定 `--json` 时：

```bash
rajio frames /work/episode --at 120,123.45 > frames.csv
```

stdout 内容为：

```csv
time,path
120,/work/episode/frames/capture-a1b2c3/frame-001.png
123.45,/work/episode/frames/capture-a1b2c3/frame-002.png
```

列顺序固定为 `time,path`，每张图片一行，不附加媒体路径说明、目录说明
或统计尾行。时间使用与 JSON 相同的数值；路径包含逗号、双引号或换行时按 CSV 规则
用双引号包裹，内部双引号写成两个双引号。需要批次目录字段时使用 `--json`。

### 失败输出

例如请求 `3.99` 秒，但 FFmpeg 未生成图片时，stderr 的核心错误信息为：

```text
No video frame was produced at requested time 3.99 seconds: /media/episode.mp4
```

沿用 CLI 现有文本错误样式；调用方不依赖日志前缀、颜色或具体措辞做判断。
参数或源文件错误应在创建批次目录之前发现；截帧失败即使发生在后续图片，也不输出
前面已生成图片的成功行。退出码为 1，stdout 为空，本次批次目录清理后不存在。
若清理本身失败，stderr 额外列出未清理目录及原因，不能声称已清理；原始截帧错误保留。

## 技术路线与证据

| 路线 | 特点 | 结论 |
| --- | --- | --- |
| 每个请求时间一次 FFmpeg seek | 参数简单，单点与区间共享逻辑；多点会重复启动和解码 GOP | 推荐首版，限制每次数量，顺序执行 |
| 单次解码配合 fps/select | 密集抽帧可减少重复解码；采样、时间戳和缺帧对应更复杂 | 有性能证据后再优化 |
| 场景检测或缩略图拼图 | 适合总览，但不直接解决指定语句附近的画面查看 | 暂不纳入 |

单点截图基本命令，输入和输出均传给 execa 参数数组，不拼接 shell：

```bash
ffmpeg -nostdin -hide_banner -loglevel error \
  -ss 123.45 -i /absolute/video.mp4 \
  -map 0:V:0 -vf "scale=w='max(1,round(iw*sar))':h=ih,setsar=1" \
  -frames:v 1 -fps_mode passthrough -update 1 /session/frames/capture-example/frame-001.png
```

过滤器按旋转后的帧宽高与 SAR 调整宽度并设为方形像素；不依赖较新版 FFmpeg 的
`reset_sar` 选项。`-fps_mode passthrough` 避免输出同步额外复制帧。
`-ss` 位于输入之前，保持默认 accurate seek，通过解码丢弃寻址点到目标之间的内容。
`0:V:0` 选择第一路非封面/附件视频流，避免将音频封面当作视频；不增加多视频轨选择器。
依据：[FFmpeg 定位与选流文档](https://www.ffmpeg.org/ffmpeg.html)。

`-frames:v 1` 限制单张输出；image2 的 `-update 1` 将路径作为固定文件名解释。
依据：[FFmpeg image2 文档](https://ffmpeg.org/ffmpeg-formats.html#image2-2)。

`fps` 通过丢帧或重复帧转换帧率，因此不能直接把生成图片的序号当作原始帧的 PTS。
依据：[FFmpeg fps 文档](https://www.ffmpeg.org/ffmpeg-filters.html#fps)。

### 本地验证

在 FFmpeg 7.1.1 上生成 4 秒、25 fps、320×180 的 H.264 测试视频，GOP 为 100。
以完整解码的 framemd5 与定位后单帧 framemd5 对照，观察到：

| 请求秒数 | 匹配的源帧时间 | PNG 生成 | FFmpeg 退出码 |
| --- | --- | --- | --- |
| 0 | 0 | 是 | 0 |
| 1.20 | 1.20 | 是 | 0 |
| 1.23 | 1.24 | 是 | 0 |
| 3.96 | 3.96 | 是 | 0 |
| 3.99 | 无 | 否 | 0 |
| 4、5 | 无 | 否 | 0 |

这验证了非关键帧定位和“成功退出但没有图片”的边界，并非所有编码、容器和时间轴的
精度保证。请求时间是查找位置，不承诺任意小数秒处存在帧；区间只约束请求点，不宣称
所选帧实际 PTS 严格落在区间内。不得自动回退到更早画面而不告知调用方。

先探测可用视频流和已知时长，拒绝明显越界参数；时长未知不按零秒处理。
执行后必须检查本次图片存在且非空，不能只看退出码或容器时长。
非零起始时间媒体使用相对源媒体起点的时间，不开启 `-seek_timestamp`。
可变帧率、音视频起点偏移、旋转和非方形像素的专项验证见下节。
HDR 到 SDR 的色彩映射不属于首版保证范围，不能声称截图颜色完全还原播放效果。

## 实现范围与验证

- 新增 `src/frames/commands.ts`、`src/frames/extract.ts`，分别负责 CLI/输出和抽帧逻辑。
  仅在确有重复时再拆辅助模块，不引入通用媒体框架。
- 在 `src/cli.ts` 注册命令，复用现有 probe、runtime 和数值解析工具。
  不为了文件归属迁移现有 audio API。
- 补充 CLI help、README 和 `skills/rajio/SKILL.md` 的按需查看画面指导。
  技能在无法从音频确定屏幕文字或视觉语境时取少量帧，不默认全视频扫描。
- 单元/CLI 测试：参数互斥、数量与时间验证、采样公式、目标与路径语义、JSON/CSV、
  缺失视频流、缺失工具、失败清理、无图片但退出码为零，以及不会创建/修改 session。
  验证输出固定落在 session 或媒体父目录的 `frames/`，不随 cwd 改变；不同调用互不覆盖，
  失败不删除其他批次，固定目录不可写时明确报错，不回退到临时目录。
  输出测试覆盖两种取帧模式的统一 JSON 结构与顺序、TTY 模式选择、CSV 列序与转义、
  stdout 无日志污染，以及后续帧失败时 stdout 为空、退出码为 1、stderr 指明失败时间。
- 临时生成真实视频做集成验证：非关键帧、末帧附近、纯音频及封面、多视频流、旋转、
  非方形像素、可变帧率、非零起始时间与音视频起点偏移。媒体夹具不入库。
- 实施后运行包测试、typecheck、build；提交 PR 前运行 `pnpm test:ci`。

### 实现验证记录（2026-10-06）

- Node 24.15.0、pnpm 12.9.0、FFmpeg/ffprobe 7.1.1。
- `pnpm --filter rajio test --run test/frames.test.ts test/cli.test.ts test/cli-error.test.ts`
  迭代检查通过；最终 `pnpm test:ci` 全仓 12 个测试文件、272 个测试通过。
- `pnpm typecheck`、`pnpm --filter rajio build` 通过；新增 TypeScript 文件通过 Prettier。
- 临时生成 4 秒、25 fps、320×180、GOP 100 的 H.264 视频，实际调用源代码 CLI：
  0、1.23、3.96 秒 PNG 与完整解码后按时间筛选的参考 PNG 哈希一致；0、3.99 秒的
  批次在第二张无产物时返回 1、stdout 为空、stderr 指明 3.99 秒，且只删除本批次。
- 4 秒请求和超出时长的区间在创建批次前失败；0–4 秒取 4 张返回
  0.5、1.5、2.5、3.5 秒。连续调用保留不同批次，不创建 session。
- 纯音频和带 PNG 封面的音频均拒绝；含 320×180 和 640×360 两路视频时选第一路。
- 90° 旋转输出 180×320；SAR=2 输出 640×180；SAR=2 加 90° 旋转输出
  90×320。三种输出的 SAR 均为 1:1，显示比例正确。旋转夹具使用输入选项
  `-display_rotation:v:0 90` 加 stream copy，并由 ffprobe 确认 Display Matrix；
  本机 `-metadata:s:v:0 rotate=90` 未写入旋转信息，不能作为旋转夹具。
- VFR 视频在 2.13 秒请求的 PNG 与完整解码参考一致；媒体起点偏移到 5 秒后，
  相对请求 1.23 秒与原视频同一请求一致。视频比音频晚 1.5 秒时，请求 0 秒取得
  视频首帧，请求 2.73 秒与原视频 1.23 秒的 PNG 一致。
- 构建后的 CLI 验证实际 TTY 表格和缩进 JSON；非 TTY CSV 在输出目录含逗号、
  双引号和换行时可正确往返解析。固定目录无写权限时返回 1、stdout 为空并报告
  EACCES，不回退到其他目录。临时媒体验证后删除，没有媒体或截图产物入库。

这些验证覆盖本机生成的有限格式与时间轴；不保证所有编码器、容器、损坏媒体或 HDR
色彩的表现。顺序启动 FFmpeg，每批最多 24 张；大量取帧的性能优化不在首版范围内。

## 兼容性与确定项

此方案只新增命令，保持现有 CLI、session 格式、版本校验及 clean/reset 行为。
`frames/` 不纳入现有 clean/reset 删除范围，截图作为独立参考资料保留。
不涉及历史数据迁移；若后续要求修改这些历史行为，按 AGENTS.md 先确认兼容要求。

“时间点＋区间均匀抽帧”的首版范围，以及去掉自定义输出目录、改为固定目录的要求
已获用户确认。实现采用上述 `frames/` 约定、`rajio frames` 名称及每批 24 张上限。
