# Beav 图片模板发布档案

`catalog.json` 是模板的作者档案，`assets/` 保存对应封面。此目录不进入 App 安装包；公共模板的运行来源是服务器市场。

## 从参考制作模板

当前用户约定的交付包括：分析完整参考图文、编写可复用指令与输入、用该模板实际生成新的中文示例封面、目视检查并将必要修订写回模板，然后更新对应市场条目并读回核对。不要直接以原图充当新封面，也不要用只供封面使用的额外风格提示掩盖模板不足。用户明确要求仅本地或不发布时遵守当前范围。

这套流程已保存为个人技能 `beav-image-template-workflow`（位于 `~/.codex/skills/`），不进入 App runtime。示例与固化记录见[翻包日记模板](../desktop/docs/image-template-selfie-bag.md)。

## 内容格式 v1

字段定义见 [schema.json](schema.json)。只验证结构和资源完整性，内容与风格由创作者判断。

```json
{
  "schemaVersion": 1,
  "templates": [{
    "id": "example-poster",
    "title": "示例海报",
    "instruction": "根据用户主题创作海报。",
    "previewUrl": "assets/example.png"
  }]
}
```

- 必填：`id`、`title`、`instruction`、`previewUrl`。模板 ID 稳定，修改内容保留 ID。
- 可选：`description`、`kind`、`industries`、`category`、`tags`、`variables`、`generationMode`、`references`、`defaults`。
- `variables` 沿用 `{ key, label, required, example? }`；`references` 沿用 `{ min, max, hint, slots?, images? }`，槽位为 `{ key, label, required }`。
- `defaults` 可指定 `aspectRatio`、`size`、`quality`。不固定账号、项目或模型。
- 只保存一份 `instruction`，不保存重复的执行提示词或由服务器分配的发布版本。
- 相对图片路径以 `catalog.json` 所在目录为根；发布程序拒绝目录逃逸，上传到市场资产服务后取得资产 ID。封面用于预览，与用户参考图分开。

## 发布

在平台管理后台的“Agent API 接入”创建对应 App 的 Key 并下载配置，在 ArtiSalesBackend 的 `gateway-api-node/` 执行：

```sh
pnpm exec tsx --tsconfig tsconfig.test.json scripts/seed-image-template-market.ts --catalog=/path/to/template-market/catalog.json
pnpm exec tsx --tsconfig tsconfig.test.json scripts/seed-image-template-market.ts --catalog=/path/to/template-market/catalog.json --config=/private/path/template-market-config.json --publish
```

默认只做离线校验；`--publish` 使用配置执行上传、保存和发布，所有业务数据通过 API 写入。连接配置包含 `base_url/app_id/app_slug/token`，放在仓库外并限制本机文件权限。也兼容既有 `IMAGE_TEMPLATE_API_BASE`、`IMAGE_TEMPLATE_APP_ID`、`IMAGE_TEMPLATE_APP_SLUG`、`IMAGE_TEMPLATE_ADMIN_TOKEN` 环境变量。凭证不写入作者目录、日志或 Git。发布后逐项读回公开详情与原图哈希；相同内容重复发布不增加版本。

封面和固定参考图上传为市场资产，图片内容统一通过已配置的 HTTPS CDN 交付。公共图片 API 仅返回 CDN 跳转；没有 CDN 时明确失败，不回退到后端传图或 OSS 源站。

更新已有 ID 时，作者档案替换模板内容，后台配置的最低 App 版本、精选及推荐排序保留。后台对标题、提示词或图片另有修改时，应先同步作者档案，避免下次发布覆盖；乐观版本检查会拒绝发布过程中的并发修改。

2026-09-15 从 20 个内置图片模板转换，提示词与封面字节保留，变量、参考图槽位与生成参数保持原值。原始笔记来源与下载记录留本机素材档案。迁移与验证进度见 [实施计划](../docs/plans/2026-09-15-server-hosted-template-market.md)。

2026-09-15 补齐本机当前公共目录的 13 个图片封面模板，作者档案现共 33 项。定义采用原有 imageGeneration.prompt，变量、参考槽位、默认参数与封面字节保持原值；5 张中文标题封面使用最新 -zh-v2 资源。来源与逐项哈希见 [迁移清单](local-catalog-migration-2026-09-15.json)。当前本机目录有 32 项，与首批 20 项重合 19 项；山野食集已在首批市场中。历史明确撤下项与被替换的旧演示模板不作为当前目录恢复。
