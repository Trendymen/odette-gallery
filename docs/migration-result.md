# 迁移结果

工程已迁入 /Users/liuzhuo/webstorm_project/odette-gallery，正式画廊地址保持 http://127.0.0.1:58855/。服务、生成和测试不再依赖旧工作区或 Codex 缓存路径。

在用图库为 544 幅作品、576 个版本、2258 个图片文件，默认精选 414、隐藏 130。原始素材和历史资料保存于 archive/current-session 与 archive/original-session，8455 个文件经旧路径读回，大小和 SHA256 全部一致；301 个过程材料文件也在搬运后核对。旧路径保留兼容链接。

停旧服务后捕获的 9 幅定制候选与 101 个删除标记已原文复制，启动后的只读 API 与页面检查保持；删除标记只保存记录。本次不重新裁剪、评分或筛选。

来源 JSON/CSV、抓取池和一次性研究脚本按原层次保留。data/provenance/assets.json 查询在用图片；archive.json 查询历史资料；sources.json 指向保存的来源原文；path-map.json 可用旧绝对路径定位新位置。无法确认的来源在索引中标为 unknown。

为保留旧相对路径及原 HTML，完整旧交付目录另存 archive/current-session/delivery-extra，直接作为兼容视图。这会额外保存约 6.48 GB 的历史在用图副本。

验收记录见 data/provenance/migration-verification.json。完整回归 89/89，生成与2258资源验证通过，代码质量和需求符合度审查通过。archive、state、node_modules、过程目录已验证Git忽略；新仓库未暂存、提交或推送。
