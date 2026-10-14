# 奥黛塔画廊

本地画廊用于浏览奥黛塔鼠标垫候选、保存定制候选和删除标记。单图页与瀑布流沿用原有筛选、排序、裁剪版本和保存行为，默认地址为 http://127.0.0.1:58855/。

需要 Node >=22。依赖安装在本工程内，版本由 package-lock.json 锁定。

GitHub 仓库为 `Trendymen/odette-gallery`。PNG、JPG 和 ZIP 使用 Git LFS 保存；克隆前安装 Git LFS，克隆后确认图片已下载，再运行项目：

```sh
git lfs install
git clone https://github.com/Trendymen/odette-gallery.git
cd odette-gallery
git lfs pull
```

在用图片约 6.48 GB，首次克隆需要下载这些资源。`archive/` 中的历史资料和未用图片、依赖及过程材料只保存在本地，未上传到 GitHub。来源和路径索引保留在 `data/provenance/`，索引指向本地归档的文件不包含在仓库中。

`state/odette_mousepad_updated/custom-candidates.json` 和 `deletion-marks.json` 随工程提交，分别保存定制候选和删除标记。新克隆会读取仓库中保存的记录；之后在画廊中的勾选会修改本地状态文件，需要再次提交并推送才能同步到 GitHub。删除标记只保存记录，不会自动删除或隐藏图片。

```sh
npm ci
npm run generate
npm run verify:assets
npm test
npm start
```

命令可从工程根运行。服务入口从源码位置解析工程目录，也可从其他工作目录运行绝对路径的 `src/server/start.mjs`。`--port` 支持 0..65535 的整数，0 会分配临时端口并输出实际地址；`--state-directory` 只接受绝对路径，适合临时验证。主机固定为 127.0.0.1。

```sh
node /absolute/project/src/server/start.mjs --port 0 --state-directory /absolute/temporary/state
```

目录用途：

| 目录 | 内容 |
| --- | --- |
| src/server | HTTP 服务、目录资格和状态存储 |
| src/gallery | 单图页、瀑布流及勾选客户端 |
| scripts | 页面生成、指纹验证与迁移入口 |
| tests | 服务、浏览器、生成与迁移回归；fixtures/manifest-557.json 是历史测试资料 |
| data/gallery | 完整 canonical manifest 和交付中的非图片原文资料 |
| data/policies | exclusions.json 排除策略 |
| data/provenance | 图片、来源、stage 和归档路径索引，以及来源 JSON 原文副本 |
| public/gallery | 页面、在用图片和下载报告 |
| state/odette_mousepad_updated | custom-candidates.json 与 deletion-marks.json 两份独立状态 |
| archive | current-session、original-session 历史工作与交付资料 |
| docs | 迁入的既有说明与迁移 Spec/Plan |

生成只读取 canonical manifest 和排除策略，过滤政策排除项后输出三份页面、裁后评分记录和评分说明。坏策略、非法或重复 ID 会使生成失败；生成不修改 canonical manifest 和两份状态。历史测试夹具的 557/424/133 断言只适用于该夹具，当前图库由 data/gallery/manifest.json 确定。

`verify:assets` 核对 manifest 默认及历史版本的 original、cropped、preview、frame 并集，逐文件校验大小和 SHA256，同时核对 canonical manifest、排除策略及 staged 非图片原文。它不读取正式状态。

迁移分两阶段，调用时传入两个旧根目录的绝对路径：

```sh
node scripts/migrate-project.mjs stage --current-root /absolute/current --original-root /absolute/original
node scripts/migrate-project.mjs archive --current-root /absolute/current --original-root /absolute/original
```

stage 复制在用图片、非图片资料和来源 JSON，源目录保持原位。archive 需要在代码审查通过并完成控制器的停服步骤后调用；它不处理 docs、state 或过程材料。archive 将旧 work 和其他 outputs 原样搬到 archive，当前完整交付目录保存为 archive/current-session/delivery-extra，包含原始 HTML、manifest、所有在用及未用文件，旧交付路径链接到该目录。工具不按排除结果删除文件，也不去重。

归档前会预扫描全部文件并建立指纹，目标冲突或未知符号链接会使操作失败。每个目录 rename 后核对文件集合和指纹，核对成功才建立旧位置链接。若搬运失败，data/provenance/archive-recovery.json 记录源、目标和 pending/moved/verified/linked 状态；先核对记录与文件实际位置，再恢复，不覆盖现有目标。跨卷 rename 失败也保留此记录。

查询旧绝对路径时，在 data/provenance/assets.json、stage.json、archive.json 的 files 中查 originalAbsolutePath，对应 projectRelativePath 是新位置。sourceRecords 指向原来源资料及 JSON pointer，sourceURLs 保留已有 URL；用 sources.json 或 archive.json 的路径映射定位原文。无法关联的文件明确记录 sourceStatus: "unknown"，不补作者或来源。

archive/、node_modules/ 和 .superpowers/ 被本地 Git 忽略。state/ 只提交上述两份状态 JSON，其余文件继续忽略。迁移未创建正式状态时，正式切换由控制器在停服后搬入最终状态并逐字节核对；测试始终使用临时状态与端口。
