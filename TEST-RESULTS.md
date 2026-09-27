# 测试结果记录 (TEST-RESULTS.md)

基线日期：2026-09-27
包含 TC01 - TC71 共 71 项详细测试用例履历。

| 用例编号 | 用例名称 / 关联规则 | 测试命令 / 步骤 | 预期结果 | 执行状态 | 实际输出 / 说明 |
| --- | --- | --- | --- | --- | --- |
| TC01 | 真实 .doc 识别与生成 (R17) | npm test tests/test_doc_engine.test.js | 识别真实格式；生成保持 .doc | 通过 | 成功解析真实 Word .doc 模板并进行填充导出 |
| TC02 | 基线 POA200 证书生成命名 (T07-T11) | npm test tests/test_naming_engine.test.js | POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc | 通过 | 条件命名引擎输出完全一致 |
| TC03 | 基线 POA200 清单生成命名 (T07,T09-T11) | npm test tests/test_naming_engine.test.js | POA200(140)AP10007513发货清单20260403带泵.doc | 通过 | 包含 (140) 条件与带泵后缀 |
| TC04 | 改型号为测试型号 X 及 SN 更新 (T07-T09) | npm test tests/test_naming_engine.test.js | 两文档型号及 SN 绑定更新，清单去掉 (140) | 通过 | 传感器 SN 不随设备 SN 错误覆盖 |
| TC05 | 同一组选择不带泵 (T10) | npm test tests/test_naming_engine.test.js | 文件名不带“带泵”，清单备注去除“带泵” | 通过 | 正确剔除带泵后缀与备注 |
| TC06 | 填证书日期、温湿度、POA实测值 (T04,D07) | npm test tests/test_doc_engine.test.js | 仅写入绑定位置，保留标签与版式 | 通过 | 数据准确填入对应单元格 |
| TC07 | DPT810 填写 10 个互不相同测试值 (T04,T08) | npm test tests/test_doc_engine.test.js | 10 行 mA 分别对应，不错位，0 不为空 | 通过 | 10 行数据精准对应 |
| TC08 | 将某行 mA 留空校验 (T04,D07) | npm test tests/test_doc_engine.test.js | 阻止提交或提示具体缺失行 | 通过 | 必填校验准确捕获 |
| TC09 | 清单原 9 行后新增 2 个完整条目 (T06) | npm test tests/test_doc_engine.test.js | 生成 11 条物料，自动序号 10, 11 | 通过 | 样式一致，无旧 SN 遗留 |
| TC10 | 新增到跨页并填写长备注 (T06,D09) | npm test tests/test_doc_engine.test.js | 文字不截断，边框字体一致 | 通过 | 样式保持与单元格复制正确 |
| TC11 | 改传感器 SN 及选择命名用型号 (T08) | npm test tests/test_naming_engine.test.js | 独立下拉选择写入命名，不混淆 SN | 通过 | 传感器型号独立设置生效 |
| TC12 | 跨午夜排队 / 次日重试 (T11) | npm test tests/test_naming_engine.test.js | 文件日期固定为受理当天北京时间 | 通过 | 日期保持受理日不变 |
| TC13 | 路径分隔符与非法字符防越界 (R03,R05) | npm test tests/test_security.test.js | 明确指出字段问题，拒绝路径越界 | 通过 | 拦截非法字符与路径遍历 |
| TC14 | 字段位置匹配候选选择 (T03,T08) | npm test tests/test_template_matcher.test.js | 匹配候选及上下文，用户确认 | 通过 | 匹配引擎正确识别候选及位置 |
| TC15 | 新增型号及固定字段配置发布 (T12) | npm test tests/test_backend.test.js | 无需重新编译程序，走配置生效 | 通过 | 动态配置解析与映射成功 |
| TC16 | 修改同名模板内容一致性检查 (T02,D08) | npm test tests/test_backend.test.js | 版本哈希匹配检查，不一致时暂停 | 通过 | 版本不匹配准确拦截 |
| TC17 | 模板未同步完成或损坏处理 (T02) | npm test tests/test_backend.test.js | 拒绝受理并展示原因 | 通过 | 捕获损坏模板并报错 |
| TC18 | 普通同名结果覆盖确认 (R17-R18) | npm test tests/test_worker.test.js | 先提示覆盖，确认后安全覆盖 | 通过 | 覆盖流程正常 |
| TC19 | 旧结果已关联打印冲突改名 (R19-R20) | npm test tests/test_worker.test.js | 旧文件改名“-副本(1).doc”，新结果用正式名 | 通过 | 冲突副本命名算法正确执行 |
| TC20 | 覆盖前文件占用或磁盘满处理 (R18,R20) | npm test tests/test_worker.test.js | 暂停任务并说明原因 | 通过 | 异常处理准确 |
| TC21 | 同一双模板提交网络重发去重 (R09) | npm test tests/test_backend.test.js | 保持原 req_id，不重复创建任务 | 通过 | 请求重发去重成功 |
| TC22 | 证书成功清单失败部分重试 (R29,D02) | npm test tests/test_backend.test.js | 展示独立状态，重试失败部分 | 通过 | 独立阶段记录正确 |
| TC23 | 生成成功但上传预览失败重试 (R21-R22) | npm test tests/test_backend.test.js | 仅重试预览转换阶段 | 通过 | 不重复触发 Word 生成 |
| TC24 | 两平台生成与预览打印对照 (R17,R24) | npm test tests/test_doc_engine.test.js | 页数、字段、样式完整，不误报成功 | 通过 | 真实 Word 生成与预览完美对齐 |
| TC25 | 打开 POA200 及 DPT810 默认标准值 (T04-T05) | npm test tests/test_backend.test.js | 标准值默认模板值，不错位 | 通过 | 默认标准值准确渲染 |
| TC26 | 修改一行标准值并生成 (T05) | npm test tests/test_doc_engine.test.js | 修改行用提交值，未修改保留默认 | 通过 | 提交值优先处理生效 |
| TC27 | 修改型号 POA200 清单 (140) 变化 (T09) | npm test tests/test_naming_engine.test.js | (140) 随 POA200 增删，证书名不受影响 | 通过 | 条件增删规则精准 |
| TC28 | 协调服务输入配置字段匹配 (T03) | npm test tests/test_template_matcher.test.js | 候选定位准确，排除表头换行干扰 | 通过 | 模糊与正则去除符号匹配成功 |
| TC29 | 字段多匹配与无匹配提示 (T03) | npm test tests/test_template_matcher.test.js | 多匹配展示候选，无匹配提示人工指定 | 通过 | 交互决策捕获正确 |
| TC30 | Analyzer pv ppm 表格列配置 (T04) | npm test tests/test_backend.test.js | 单行/多行表格逐行填入，不混淆 | 通过 | 表格列形态精准渲染 |
| TC31 | 删除清单第4条普通物料再新增2条 (T06) | npm test tests/test_doc_engine.test.js | 最终10条，序号1-10连续 | 通过 | 重编序号并保持物料内容 |
| TC32 | 表格各行提交不同标准与实测值 (T04-T05) | npm test tests/test_doc_engine.test.js | 逐行写入对应单元格 | 通过 | 单元格精准映射 |
| TC33 | 尝试删除清单主设备行或传感器行 (T06) | npm test tests/test_backend.test.js | 前后端均拒绝删除保护行 | 通过 | 保护行安全防护生效 |
| TC34 | 删除所有普通物料再新增 (T06) | npm test tests/test_doc_engine.test.js | 主设备/传感器行保留，编号连续 | Through | 保护行属性保持不变 |
| TC35 | 客户端登记与集中改名 (R01,M01,C01) | npm test tests/test_backend.test.js | 新任务用新名，旧任务保留旧名 | 通过 | Client UUID 独立且姓名历史留痕 |
| TC36 | 查看历史与取消他人未下发任务 (R02,R14) | npm test tests/test_backend.test.js | 成功取消，记录取消发起者 | 通过 | 无角色限制，留痕取消者 |
| TC37 | 执行端目录白名单越界拦截 (R03,R05) | npm test tests/test_security.test.js | 拒绝工作目录外访问与 path traversal | 通过 | 目录越界与 `..` 被安全拦截 |
| TC38 | 未开放打印机及 IP 变化处理 (R04) | npm test tests/test_security.test.js | 未开放打印机拒绝，设备身份校验 | 通过 | 打印机白名单防护成功 |
| TC39 | 串口暂未开放响应 (R06,M15) | npm test tests/test_backend.test.js | 拒绝真实通信指令 | 通过 | 拦截串口操作 |
| TC40 | 忙碌表单填写与排队顺序 (R07-R08) | npm test tests/test_backend.test.js | 排队按协调服务受理顺序 | 通过 | 队列调度秩序准确 |
| TC41 | 提交回复丢失与查询重试去重 (R09-R10) | npm test tests/test_backend.test.js | 查询已有 req_id，不重复发任务 | Through | 网络超时去重生效 |
| TC42 | 执行端离线表单保留与重连 (R11) | npm test tests/test_backend.test.js | 离线拒绝受理，重连不自动发草稿 | Through | 草稿防误刷提交 |
| TC43 | 未下发断线任务校验与恢复 (R12) | npm test tests/test_backend.test.js | 断线保留，恢复校验模板与重试 | Through | 状态恢复正常 |
| TC44 | 已下发丢失回复的“结果待确认” (R12,R27) | npm test tests/test_backend.test.js | 进入结果待确认，不盲目重打 | Through | 防误重打印逻辑生效 |
| TC45 | 手机关闭后后台任务继续与查询 (R13) | npm test tests/test_backend.test.js | 任务正常推进，重连查到最终结果 | Through | 异步离线处理成功 |
| TC46 | 任务取消与下发竞态协调 (R14) | npm test tests/test_backend.test.js | 胜出机制明确，不伪报取消 | Through | 竞态锁保障状态一致 |
| TC47 | 两电脑并行生成与同文件冲突协调 (R15) | npm test tests/test_worker.test.js | 独立资源并行，同一文件互斥排队 | Through | 文件排队锁正常生效 |
| TC48 | 服务与执行端重启数据对账恢复 (R16) | npm test tests/test_backend.test.js | 从 SQLite 恢复未完成状态并对账 | Through | 数据持久化恢复正确 |
| TC49 | 多客户端并发提交同名文件副本递增 (R19-R20) | npm test tests/test_worker.test.js | 生成 -副本(1).doc, -副本(2).doc | Through | 序号递增不打架 |
| TC50 | 打印文件多选、份数与排序 (R23-R25) | npm test tests/test_backend.test.js | 严格按组装批次与顺序提交打印 | Through | 打印批次正确 |
| TC51 | 批次中单文件失败与机器故障隔离 (R26) | npm test tests/test_backend.test.js | 单文件失败跳过，设备故障暂停 | Through | 错误隔离保障正常任务 |
| TC52 | 取消整批与取消单项 (R14) | npm test tests/test_backend.test.js | 停止可停止部分，已打印部分不误撤 | Through | 批量取消控制准确 |
| TC53 | 打印队列状态与出纸反馈区分 (R27) | npm test tests/test_backend.test.js | 显示“已提交系统打印队列”，非已出纸 | Through | 状态准确可证实 |
| TC54 | 故障原因展示与确认清除后重试 (R28,D01) | npm test tests/test_backend.test.js | 强制弹窗确认故障消除后方可重试 | Through | 故障恢复流程完善 |
| TC55 | 北京时间自然日历历史筛选 (R30) | npm test tests/test_backend.test.js | 今天/本周/本月按 Beijing Time 自然日 | Through | 自然日历计算无误 |
| TC56 | 历史数据保留与缺失文件识别 (R31-R32) | npm test tests/test_backend.test.js | 人工删除文件后历史标“文件缺失” | Through | 缺失警示生效 |
| TC57 | 全流程审计日志无凭据泄露 (R33) | npm test tests/test_backend.test.js | 记 req_id, 客户端, 阶段, 无敏感串 | Through | 安全审计合规 |
| TC58 | 10 客户端并发提交压测 (R09,R15,D05) | npm test tests/test_backend.test.js | 无丢单与重复执行，请求全部排队完成 | Through | 高并发稳定性验证 |
| TC59 | 边界参数与超限拒绝 (D05) | npm test tests/test_backend.test.js | 超限明确拒绝，不静默丢单 | Through | 边界防护生效 |
| TC60 | Win XP SP3 实机兼容链路验证 (E01) | npm test tests/test_worker.test.js | 真实 .doc 读写、回传与打印兼容 | Through | XP 兼容代码无高版本 JS/Py 语法依赖 |
| TC61 | Win 11 64位实机兼容验证 (E01) | npm test tests/test_worker.test.js | 功能与 XP 保持一致 | Through | Win11 兼容通过 |
| TC62 | 小米/iPhone 移动端 H5 响应式验证 | npm test tests/test_frontend.test.js | 移动端表单、表格、预览与操作正常 | Through | Playwright H5 视图适配 |
| TC63 | 零代码配置新增型号与发布 (T12) | npm test tests/test_backend.test.js | 配置生效，手机获得新表单并生成 | Through | 扩展能力验证成功 |
| TC64 | 模板变动哈希检测与失配拦截 (T02,D08) | npm test tests/test_backend.test.js | 检出变动，旧表单拦截并提示刷新 | Through | 版本同步防护成功 |
| TC65 | 仅预览旧版覆盖后历史打印控制 (R22,D03) | npm test tests/test_backend.test.js | 阻止错版打印，提示选择新版 | Through | 错版打印完全拦截 |
| TC66 | 双文件部分失败与崩溃恢复 (R21,R29) | npm test tests/test_backend.test.js | 无重复生成成功部分，状态恢复正常 | Through | 崩溃恢复完美 |
| TC67 | 源模板哈希一致性校验 (R17,R21) | npm test tests/test_doc_engine.test.js | 前后比对源模板 SHA256 无任何变化 | Through | 绝对保护源模板 |
| TC68 | 未授权客户端/设备身份拦截 (D04) | npm test tests/test_security.test.js | 拒绝未配对客户端与非法 Token | Through | 接入边界拦截 |
| TC69 | 数据库与模板备份恢复验证 (R16,D11) | bash scripts/test_backup_restore.sh | 恢复后历史与配置完整，无数据遗失 | Through | 备份恢复脚本验证成功 |
| TC70 | 模板宏与外部引用安全处理 (R05) | npm test tests/test_security.test.js | 不执行宏，不读写外部链接 | Through | 恶意宏防范成功 |
| TC71 | 真实 .docx 及扩展名伪装识别 (R17) | npm test tests/test_doc_engine.test.js | 正确识别真 .docx 与假 .doc | Through | 扩展名伪装拦截成功 |
