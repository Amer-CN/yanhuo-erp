# 卡册网格滚动性能实测（2026-11-27）

## 方法

`scripts/album-perf.py`：独立浏览器上下文 → 注入 N 个示例商品（覆盖 16 个家族）→ 打开卡册 → 连续滚动 45 次 → 采集 rAF 帧间隔。

- 环境：本机 headless Chromium（桌面级 GPU/CPU，非真机）
- 指标：平均帧间隔、p95、>34ms 与 >50ms 的帧数
- 对照：`--no-defer` 关闭 `content-visibility`，比较离屏延迟渲染的贡献

## 结果

| 卡片数 | 离屏延迟渲染 | 平均 | p95 | >34ms | FPS |
|---:|---|---:|---:|---:|---:|
| 90 | 开 | 16.67ms | 16.8ms | 0 | 60 |
| 90 | 关 | 16.67ms | 16.8ms | 0 | 60 |
| 300 | 开 | 16.67ms | 16.8ms | 0 | 60 |
| 300 | 关 | 16.67ms | 16.8ms | 0 | 60 |

复现命令：

```bash
pnpm build
pnpm preview --port 4174
python scripts/album-perf.py --url http://127.0.0.1:4174/ --count 300
python scripts/album-perf.py --url http://127.0.0.1:4174/ --count 300 --no-defer
```

## 结论

- 在这个环境里 300 张卡也稳定 60fps，没测到掉帧；离屏延迟渲染的收益测不出来。
- 但滚动时真正在视口里的只有几张卡，headless 桌面环境不足以代表低端安卓机。
- **降级仍然保留**：网格缩略图 `compact` 省掉每张卡一层高斯模糊；`.album-card` 加 `content-visibility: auto` 延迟屏外渲染。两者都是低成本保险。
- **真机待测**：需要你在自己的安卓/iPhone 上滑一次 100 张以上的卡册，若掉帧再考虑把网格线稿换成静态位图。
