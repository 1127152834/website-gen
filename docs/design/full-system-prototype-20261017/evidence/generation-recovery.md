# 生成恢复记录

- W09-v2 首次局部编辑在两轮 120 秒等待后没有返回结果，停止本地等待；不声称远端任务取消或成功。保持 W09-v1 为待修正草稿，使用同一已保存提示词重试，只有实际返回并保存的图片可更新状态。

所有重试保留原始图和提示词，不将工具等待当作图像已完成，不改用未获授权的外部 API/CLI。

## G04 retry
Cell 164 produced and archived G03-v1, then no further result after repeated 120-second waits. The local cell was terminated. Source folder and ledger contain no G04 output; G02-snapshot was not reached. Resume from verified G03 checkpoint, retry G04 once using its saved exact prompt; no duplicate image is claimed.

## O-G10 retry
Cell177 completed O-G05/O-G09, then no result after over8minutes waiting for O-G10. Terminated local wait; preserve two archived images. Resume remaining O-G10/O-G11 after checking ledger and source folder. No duplicate result claimed.

## Intermittent connection failure checkpoint
Root O-G12 first call failed with connection failed: error sending request, no output; remaining same-cell jobs were not reached. Mail/other modules independently observed same error. Existing PNGs retained. Reviewer reported subsequent C02-v4 successful single retry; treat as intermittent, not proof of full recovery or quota reason. Continue bounded single calls from saved checkpoints.
