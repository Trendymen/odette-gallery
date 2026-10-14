# 定制候选 Implementation Plan

> For agentic workers: 使用superpowers:subagent-driven-development执行下列任务；主线程协调实现代理，完成需求符合度和代码质量两个独立审查。用户已明确要求不再确认并自主推进。

**Goal:** 在两个画廊视图中即时勾选定制候选，同源服务持久保存并在刷新、重启后恢复。

**Architecture:** Node标准库静态/API服务，最终manifest减排除名单作为允许目录；JSON状态与目录签名共用持久revision。共享选择客户端由两个renderer内联生成，单图定制筛选另读取全量目录。

**Tech Stack:** Node 22.21.1、ESM、node:http、node:fs/promises、node:test、已安装Playwright；无新增生产依赖。

**Spec:** `docs/superpowers/specs/2026-10-14-custom-candidates-design.md`

## Global Constraints

- 正式服务固定 `127.0.0.1:58855`，静态根为 `outputs/odette_mousepad_updated/`；端口冲突退出，不自动换端口。
- 状态为 `state/odette_mousepad_updated/custom-candidates.json`，位于outputs之外；按作品ID保存，不保存裁剪版本。
- 全量目录来自最终manifest，排除名单来自 `work/male-pair-filter/exclusions.json`；目录变化和选择变化都递增持久revision。
- 图片、评分、默认裁剪不修改；隐藏作品可加入定制候选，已排除作品不可复活，空的例外不变。
- 瀑布流三列、单图原有过滤/版本/键盘/下载行为保留。API失败不能伪装已保存或空状态。
- 非Git目录，不初始化仓库、创建worktree或编造提交。过程材料用当前Plan专属workspace，审查绑定文件快照和patch SHA256。
- 说明与注释按shuorenhua minimal自查；产品代码交给general实现，主线程负责生成交付与实际验收。

## Review Focus

- selectedIds不变但排除策略更新，旧GET后返回不能恢复旧allowedIds。
- 同ID连续点击和不同ID并发，响应不能覆盖未保存的最后意图。
- JSON损坏、目录读取失败及写入/替换失败，保留原有效状态并允许重试。
- 从隐藏区勾选后，在精选单图页的定制筛选也能找到；取消末项与空集合定位正确。
- 内部导航等待未完成保存，失败留原页；file协议浏览保持可用但不假装能保存。

## Task 1: 完整实现定制候选与服务

这是一项服务与客户端契约相互依赖的功能，统一实现并审查全部产品改动；服务、状态、UI分别运行自己的测试周期。该Task的两个独立reviewer同时覆盖整个改动范围，兼作全范围代码审查。

**Files:**
- Create: `work/gallery-server/package.json`
- Create: `work/gallery-server/src/catalog.mjs`
- Create: `work/gallery-server/src/selection-store.mjs`
- Create: `work/gallery-server/src/server.mjs`
- Create: `work/gallery-server/src/start.mjs`
- Create: `work/gallery-server/tests/catalog-store.test.mjs`
- Create: `work/gallery-server/tests/server.test.mjs`
- Create: `work/gallery-server/tests/gallery-browser.test.mjs`
- Create: `work/crop-rescore/custom-selection-client.mjs`
- Modify: `work/crop-rescore/render-scored-gallery.mjs`
- Modify: `work/crop-rescore/render-thumbnail-gallery.mjs`
- Modify if needed: `work/masonry-change/tests/gallery.test.mjs`
- Modify: `work/masonry-change/tests/export-exclusions.test.mjs`（隔离夹具须复制新增共享客户端依赖）
- Create: `work/gallery-server/README.md`

**Interfaces:**
- `readCatalog({manifestPath, exclusionsPath})` 返回 `allowedIds:Set<string>`、`excludedIds:Set<string>`、`catalogRevision:string`。验证数组、ID和重复项；目录异常由HTTP映射503。
- `createSelectionStore({stateFile, readCatalog, fsOps})` 返回异步 `get()` 与 `set(id, selected)`；fsOps默认为真实fs，失败测试可提供限定文件操作故障。返回JSON响应快照字段见Spec。所有操作共用串行事务队列，目录读取也在队列内。
- `createGalleryServer({galleryDirectory, stateFile, exclusionsPath})` 返回未listen的Node http.Server，默认manifest取galleryDirectory/manifest.json。导入模块不启动端口或注册进程信号。
- `start.mjs` 创建正式服务，listen成功后打印URL；SIGINT/SIGTERM关闭服务。package脚本 `start: node src/start.mjs`、`test: node --test tests/*.test.mjs`。
- `createCustomSelectionClient({artworks})` 接收完整目录，提供 `subscribe(listener)`、`toggle(id, selected)`、`retry()`、`flush()`、`getSnapshot()`；subscribe接收快照回调，flush返回保存完成的Promise，失败则reject。快照包含本地有效selectedIds/allowedIds数组、ready、pendingIds/failedIds数组、error、revision及catalogRevision。两个renderer只适配各自显示，不重写保存协议。
- 单图保留原id=data数据块契约，新增完整目录数据块；普通列表仍取原页数据，custom列表取全量目录与本地选择集合。瀑布流原全量卡片数据继续使用当前默认裁后JPEG。

- [ ] Step 0: 第一次产品写入前运行当前SDD skill的scripts/sdd-workspace获取本Plan专属workspace。非Git导致helper失败时，保留真实错误，用任务本地副本仅适配根目录解析，保留原Plan归属/碰撞/自忽略逻辑，由该helper打印路径，不手写猜目录，不修改插件缓存。记录这一非Git适配。将全部已有待修改文件复制到workspace/baseline并记录SHA256；逐项记录新增文件原先不存在。将当前正式manifest.json、manifest-curated.json、crop-scores.json、verification.json复制到baseline/data并记录来源/指纹，verification.json内2258份图片SHA作为不可变图片基线。范围扩大时，在第一次修改新路径前补采基线。后续diff只使用这份基线。
- [ ] Step 1: 写catalog/store测试并运行RED：允许集合减排除、坏目录失败；首次持久空revision0；重建store读取已选ID；同值幂等；100个不同ID并发不丢失；目录签名改变且selectedIds不变也递增revision；旧ID清理；损坏状态不覆盖；写入/rename失败保持旧文件且重试成功。
- [ ] Step 2: 最小实现catalog与store，运行这些测试至GREEN；记录真实RED/GREEN输出，不用导入报错代替行为失败。
- [ ] Step 3: 写真实HTTP测试并运行RED：静态首页与图片/HEAD；GET与合法PUT持久状态；400/404/410/413/500/503；非JSON、非同源Origin、非法Host、错误方法、编码路径穿越和越界符号链接；目录读取失败不清空旧选择。
- [ ] Step 4: 实现server、正式入口与package脚本，运行HTTP和store测试至GREEN。所有测试用临时目录与端口并在结束关闭服务。
- [ ] Step 5: 写浏览器RED测试：首次GET延迟期间控件禁用，GET失败显示错误且不冒充已确认空集合，重试成功恢复控件；选中后延迟PUT期间立即进入custom；隐藏作品跨两视图可见；勾选不导航；刷新恢复；取消末项/最后一项；保存失败提示及重试；同ID最后意图、低revision拒绝、目录改变的旧GET晚到、两标签页广播、内部导航等待保存、file入口禁用保存。
- [ ] Step 6: 实现共享客户端与两个renderer适配。factory作为共享来源内联，保持原静态访问和原主数据块；完整目录初始默认版本排序。自定义筛选参数为scope=custom，返回链接保存scope和id。更新export-exclusions.test.mjs的隔离夹具复制清单，包含共享模块及其他实际新增renderer依赖，不从正式输出目录借用文件。
- [ ] Step 7: 运行 `npm --prefix work/gallery-server test` 和 `node --test work/masonry-change/tests/*.test.mjs`。失败先修正实际行为；保存测试名、命令、输出、源文件指纹及实现报告。
- [ ] Step 8: 按spec/plan逐项自查，说明未验证项。将报告写到本Task的workspace报告文件，交回主线程，不自行生成正式输出或调度reviewer。
- [ ] Step 9: 主线程使用Step 0的不可变baseline生成当前快照diff及patch hash，全部新增/修改文件及夹具调整都进入范围，分别派 `SPEC_COMPLIANCE` 和 `CODE_QUALITY` reviewer；Critical/Important修复后复用原reviewer复审。无Git提交，任务状态以实际文件、测试和审查指纹为准。

## Task 2: 正式输出、现有Chrome验收与交付

此Task仅使用已审查实现生成与验证交付，不新增产品代码。若出现代码问题，回Task 1修复并复审后再继续。

**Files:** 输出目录三个HTML、README/功能说明/审查与浏览器核验记录；完整图片ZIP及sha256；过程证据位于当前Plan workspace。

- [ ] Step 1: 用最终manifest调用writeScoredGallery重新生成页面和评分记录，避免重新裁图；保留用户确认的013/027/043/087/095默认版本。
- [ ] Step 2: 启动使用独立临时状态的真实HTTP服务，在现有Chrome验证勾选、即时custom、隐藏作品、跨页同步和刷新。停止/重启该测试服务核对状态恢复，检查正式端口第二实例拒绝。
- [ ] Step 3: 停止测试服务，启动正式 `npm --prefix work/gallery-server start`；正式状态不预选任何作品。打开 `http://127.0.0.1:58855/thumbnails.html`，核对原三个数量、custom空状态和控件可用。正式服务按用户要求继续运行，测试服务必须关闭。
- [ ] Step 4: 核对当前manifest、crop-scores、图片SHA与上一轮2258图基线一致；核对页面数据和544作品/414精选/130隐藏快照，已排除资产仍不存在。
- [ ] Step 5: 更新启动说明和功能文档，明确file入口只浏览、服务入口可保存。保留原始下载缓存，正式状态文件不进图片包。
- [ ] Step 6: 完整重建ZIP，核对文件清单、CRC和SHA256后替换旧包；更新Plan ledger与update_plan，只依据真实证据标记完成。
