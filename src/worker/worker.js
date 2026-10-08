const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { generateWordDocument } = require('./word_engine');
const { isPathInWhitelist, isPrinterAllowed, isSubpath, safeRealPath } = require('./security');
const { handleFileConflictAndOverwrite } = require('./conflict');
const { getFileSha256 } = require('../common/utils');
const {
  loadWorkerConfig,
  classifyConnectionError,
  firewallHint,
  LOCAL_CONFIG_PATH
} = require('./worker_config');

/**
 * Dynamic System Printer Detector for Windows (PowerShell CIM Query)
 * Rules: R04, R05
 */
function getInstalledSystemPrinters() {
  if (process.platform === 'win32') {
    try {
      const output = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"', {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const lines = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length > 0) return lines;
    } catch (e) {
      try {
        const output = execSync('wmic printer get name', {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const lines = output.split(/\r?\n/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'name');
        if (lines.length > 0) return lines;
      } catch (err) {
        return [];
      }
    }
  }
  return [];
}

class ExecutionWorker {
  constructor(config = {}) {
    // 配置来源与优先级统一由 worker_config 模块决定（命令行 > 本机身份文件 > 共享配置 > 环境变量 > 默认）
    const resolved = loadWorkerConfig();
    this.configSources = resolved.sources;
    this.identityGenerated = resolved.identityGenerated;
    this.explicitRemote = resolved.explicitRemote;
    this.localConfigPath = resolved.configPaths.local;

    this.workerId = config.workerId || resolved.workerId;
    this.workerSecret = config.workerSecret || resolved.workerSecret;
    this.name = config.name || resolved.name || `执行终端 (${this.workerId})`;
    this.serverUrl = config.serverUrl || resolved.serverUrl;
    // 执行端是纯客户端：不监听任何端口（183 部署文档 §3.2），因此无需记录监听地址
    this.savedOnThisMachine = resolved.savedOnThisMachine;
    this.workingDir = config.workingDir || resolved.workingDir;

    // 打印机白名单：显式配置 > 共享配置 > 自动探测
    if (config.allowedPrinters && config.allowedPrinters.length > 0) {
      this.allowedPrinters = config.allowedPrinters;
    } else if (resolved.allowedPrinters && resolved.allowedPrinters.length > 0) {
      this.allowedPrinters = resolved.allowedPrinters;
    } else {
      this.allowedPrinters = getInstalledSystemPrinters();
    }

    if (!fs.existsSync(this.workingDir)) {
      fs.mkdirSync(this.workingDir, { recursive: true });
    }

    // 断线重连状态：区分「从未连上」「已断开」「已连接」，避免重复刷日志
    this._connected = null;
    this._lastErrorKind = null;
    this._lastErrorText = '';
    this._connectAttempts = 0;
    // 身份冲突（同 workerId 被复制到另一台电脑）时服务端会下发冲突标记
    this.identityConflict = null;
  }

  /** 统一的执行端请求头：身份与接入凭据（服务端据此校验归属，不信任请求体自报） */
  workerHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'x-worker-id': this.workerId,
      'x-worker-token': this.workerSecret,
      ...extra
    };
  }

  /** 上传 multipart 时不能自定义 Content-Type（需保留 boundary），只带身份头 */
  workerAuthHeaders(extra = {}) {
    return {
      'x-worker-id': this.workerId,
      'x-worker-token': this.workerSecret,
      ...extra
    };
  }

  /**
   * 心跳：只有 HTTP 成功 + 响应结构正确 + success 为真 + 返回的 workerId 与自己一致时，
   * 才算「已连接」（整改 §5 / MW-B04）。403/401 等业务错误不得被当作已连接。
   */
  async sendHeartbeat() {
    let res;
    try {
      res = await fetch(`${this.serverUrl}/api/workers/heartbeat`, {
        method: 'POST',
        headers: this.workerHeaders(),
        body: JSON.stringify({
          workerId: this.workerId,
          name: this.name,
          workingDir: this.workingDir,
          printers: this.allowedPrinters,
          status: 'ONLINE',
          selfReportedIp: this.selfReportedIp || undefined,
          // 说明本机不提供任何入站服务（183 部署文档 §3.2）
          inboundServices: 'none'
        })
      });
    } catch (err) {
      return this.noteDisconnected(classifyConnectionError(err));
    }

    const contentType = res.headers.get('content-type') || '';
    let data = null;
    if (contentType.includes('application/json')) {
      try { data = await res.json(); } catch (e) { data = null; }
    }

    if (!data) {
      return this.noteDisconnected({
        kind: 'bad-response',
        text: `协调服务响应不是有效 JSON（HTTP ${res.status}）`
      });
    }
    if (!res.ok) {
      const detail = data.error || `HTTP ${res.status}`;
      const kind = res.status === 401 || res.status === 403 ? 'auth' : (res.status === 409 ? 'conflict' : 'server');
      // 身份冲突：服务端明确指出该 ID 已被另一台电脑占用
      if (res.status === 409 && data.identityConflict) {
        this.identityConflict = data;
      }
      return this.noteDisconnected({ kind, text: `${detail}（目标 ${this.serverUrl}）` });
    }
    if (data.success !== true) {
      return this.noteDisconnected({ kind: 'bad-response', text: `协调服务未确认成功（HTTP ${res.status}，success=${data.success}）` });
    }
    if (data.workerId && data.workerId !== this.workerId) {
      return this.noteDisconnected({
        kind: 'identity-mismatch',
        text: `协调服务返回的 workerId (${data.workerId}) 与本机 (${this.workerId}) 不一致，拒绝标记为已连接`
      });
    }

    this.noteConnected(data);
    await this.pollAndExecuteDirectoryChecks();
    return data;
  }

  noteConnected(data) {
    const firstTime = this._connected !== true;
    this._connected = true;
    this.identityConflict = null;
    if (firstTime) {
      this._connectAttempts = 0;
      console.log(`[成功] 已连接协调服务 (${this.serverUrl})！状态: ONLINE，终端ID: ${this.workerId}`);
      if (data && data.registered === true) {
        console.log(`[身份] 本终端为首次登记，接入凭据已在本机持久化: ${this.localConfigPath}（请勿复制到其他电脑）`);
      }
      if (this.explicitRemote && /127\.0\.0\.1|localhost/.test(this.serverUrl)) {
        console.warn(`[提示] 当前连接地址仍是本机回环 (${this.serverUrl})；远程电脑请用 --server http://<协调电脑局域网IP>:3001 指定协调服务地址。`);
      }
    }
  }

  /** 未连接状态：区分错误类型，避免把所有问题都描述成“等待协调服务启动” */
  noteDisconnected(info) {
    const changed = this._connected !== false || this._lastErrorKind !== info.kind || this._lastErrorText !== info.text;
    this._connected = false;
    this._lastErrorKind = info.kind;
    this._lastErrorText = info.text;
    this._connectAttempts = (this._connectAttempts || 0) + 1;
    if (changed) {
      const label = {
        refused: '[连接失败]',
        timeout: '[连接超时]',
        dns: '[地址解析失败]',
        unreachable: '[网络不可达]',
        reset: '[连接被重置]',
        auth: '[鉴权失败]',
        conflict: '[身份冲突]',
        server: '[协调服务错误]',
        'bad-response': '[响应异常]',
        'identity-mismatch': '[身份不一致]',
        unknown: '[连接异常]'
      }[info.kind] || '[连接异常]';
      console.error(`${label} 目标 ${this.serverUrl} —— ${info.text}`);
      if (info.kind === 'auth') {
        console.error('  处理建议：该终端 ID 已登记且凭据不匹配。请核对本机 worker_config.local.json，或删除它后以“注册为新终端”的方式重新接入。');
      }
      if (info.kind === 'conflict') {
        console.error('  处理建议：本机身份文件疑似从另一台电脑复制而来。请删除本机 worker_config.local.json 后重启，以获得新的终端身份。');
      }
      if (info.kind === 'refused' || info.kind === 'timeout') {
        console.error('  处理建议：确认协调服务已启动且监听地址允许局域网接入，并检查防火墙是否按需放行该 TCP 端口。');
      }
    }
    return null;
  }

  /**
   * 拉取本执行端当前有效的业务路径授权。
   * 返回值区分“能否确认授权”与“具体授权内容”，无法确认时执行前必须暂停 (4.2, WC-18)
   */
  async fetchAuthorizations() {
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/authorizations?workerId=${encodeURIComponent(this.workerId)}`, { headers: this.workerAuthHeaders() });
      if (!res.ok) {
        return { ok: false, reason: `协调服务返回 ${res.status}，无法确认当前授权状态` };
      }
      const data = await res.json();
      return {
        ok: true,
        authState: data.authState || 'UNKNOWN',
        allowedPaths: Array.isArray(data.allowedPaths) ? data.allowedPaths : []
      };
    } catch (e) {
      return { ok: false, reason: `无法连接协调服务确认当前授权状态: ${e.message}` };
    }
  }

  async fetchActiveAuthorizations() {
    const auth = await this.fetchAuthorizations();
    return auth.ok ? auth.allowedPaths : [];
  }

  /**
   * 执行前校验：目标目录是否位于执行端当前授权范围内。
   * 授权撤销、写权限取消、授权范围待确认、无法确认协调服务时一律拒绝 (E04, 4.2, WC-18, WC-20)
   */
  async ensureWriteAuthorized(targetDir, rootDir) {
    const auth = await this.fetchAuthorizations();
    if (!auth.ok) {
      throw new Error(`无法确认执行端当前有效授权（${auth.reason}），已暂停写入 (4.2, WC-18)`);
    }
    if (!isSubpath(rootDir, targetDir)) {
      throw new Error(`安全拦截：目标保存路径 [${targetDir}] 试图跳出指定根目录范围 [${rootDir}]！(DIR-13, WC-08)`);
    }
    if (!isSubpath(rootDir, safeRealPath(targetDir))) {
      throw new Error(`安全拦截：目标保存路径经目录联接/符号链接解析后跳出根目录范围 [${targetDir}]！(6.7, WC-08)`);
    }

    const writeRoots = auth.allowedPaths.filter(ap => ap.allow_write);
    if (writeRoots.length === 0) {
      const detail = auth.authState === 'EXPLICIT'
        ? '执行端当前没有任何允许写入的业务路径（授权已被撤销或未配置）'
        : '执行端当前授权范围内没有任何可写业务路径（授权已撤销，或授权范围尚待管理员确认）';
      throw new Error(`任务保存目标目录已不在执行端当前授权范围内（${detail}），拒绝执行写入 (WC-20)`);
    }
    const covering = writeRoots.find(ap => isSubpath(ap.root_path, targetDir));
    if (!covering) {
      throw new Error(`任务保存目标目录 [${targetDir}] 已不在执行端当前授权范围内（授权已撤销或失效），拒绝执行写入 (WC-20)`);
    }
    return { authState: auth.authState, authorizedRoot: covering.root_path, version: covering.version };
  }

  async pollAndExecuteDirectoryChecks() {
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/directory-checks/pending?workerId=${this.workerId}`, { headers: this.workerAuthHeaders() });
      if (!res.ok) return;
      const checks = await res.json();
      for (const check of checks) {
        await this.executeDirectoryCheck(check);
      }
    } catch (err) {}
  }

  async executeDirectoryCheck(check) {
    const rootDir = check.root_dir;
    const allowCreate = Boolean(check.allow_create);
    const checkType = check.check_type || 'save_config';
    const allowRead = check.allow_read === undefined ? true : Boolean(check.allow_read);
    const allowWrite = check.allow_write === undefined ? true : Boolean(check.allow_write);

    let status = 'PASSED';
    let message = '检查通过，目录可写';

    if (!rootDir || typeof rootDir !== 'string') {
      status = 'FAILED';
      message = '保存路径不能为空';
    } else {
      const isAbs = path.isAbsolute(rootDir) || /^[a-zA-Z]:[\\/]/.test(rootDir);
      const driveMatch = rootDir.match(/^([a-zA-Z]:)(.*)$/);
      const pathBody = driveMatch ? driveMatch[2] : rootDir;

      if (!isAbs) {
        status = 'FAILED';
        message = `路径不是合法的绝对路径: ${rootDir}`;
      } else if (/[<>"|?*]/.test(pathBody)) {
        status = 'FAILED';
        message = `路径包含系统非法字符: ${rootDir}`;
      } else if (checkType === 'save_config') {
        // WC-08, E04: 保存目录必须位于当前授权写入范围内，且授权必须能被确认
        const auth = await this.fetchAuthorizations();
        if (!auth.ok) {
          status = 'FAILED';
          message = `无法确认执行端当前有效授权（${auth.reason}），检查不予通过 (4.2, WC-18)`;
        } else if (auth.allowedPaths.filter(ap => ap.allow_write).length === 0) {
          status = 'FAILED';
          message = `执行端当前没有任何允许写入的业务路径，保存目录未获授权 (E04, WC-08)`;
        } else if (!auth.allowedPaths.some(ap => ap.allow_write && isSubpath(ap.root_path, rootDir))) {
          status = 'FAILED';
          message = `保存目录未在允许访问的业务路径范围内 (E04, WC-08)`;
        }
      } else if (checkType === 'allowed_path') {
        // 业务路径本身也要区分读写权限验证，避免允许读取被误判为可写 (4.2)
        if (allowWrite) {
          // 写权限在存在性/创建检查与探测阶段验证
        } else if (!fs.existsSync(rootDir)) {
          status = 'FAILED';
          message = `只读授权路径不存在: ${rootDir}`;
        } else {
          try {
            fs.readdirSync(rootDir).slice(0, 1);
          } catch (rErr) {
            status = 'FAILED';
            message = `授权路径不可读或权限不足: ${rErr.message}`;
          }
        }
      }

      if (status === 'PASSED' && !fs.existsSync(rootDir)) {
        if (!allowCreate) {
          status = 'FAILED';
          message = `根目录不存在，且未勾选允许创建: ${rootDir} (DIR-09, WC-10)`;
        } else {
          try {
            fs.mkdirSync(rootDir, { recursive: true });
          } catch (mErr) {
            status = 'FAILED';
            message = `创建根目录失败: ${mErr.message} (DIR-10)`;
          }
        }
      }
    }

    if (status === 'PASSED' && allowWrite) {
      const probeFile = path.join(rootDir, `.write_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      try {
        // 探测不得覆盖已有文件，且无论成功失败都要清理临时文件 (6.2)
        if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
        fs.writeFileSync(probeFile, 'probe');
        const readBack = fs.readFileSync(probeFile, 'utf-8');
        if (readBack !== 'probe') throw new Error('探测文件校验失败');
      } catch (err) {
        status = 'FAILED';
        message = `目录不可写或权限不足: ${err.message} (DIR-11)`;
      } finally {
        try { if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile); } catch (e) {}
      }
    } else if (status === 'PASSED' && !allowWrite && !allowRead) {
      status = 'FAILED';
      message = '该路径既未授权读取也未授权写入，配置无效 (4.2)';
    }

    try {
      await fetch(`${this.serverUrl}/api/worker/directory-checks/result`, {
        method: 'POST',
        headers: this.workerHeaders(),
        body: JSON.stringify({
          checkId: check.id,
          workerId: this.workerId,
          checkType,
          targetId: check.target_id || check.config_id,
          configId: check.config_id || check.target_id,
          version: check.version,
          status,
          message
        })
      });
    } catch (e) {}
  }

  async pollAndExecuteTasks() {
    try {
      await this.pollAndExecuteDirectoryChecks();
      const res = await fetch(`${this.serverUrl}/api/worker/tasks/pending?workerId=${this.workerId}`, { headers: this.workerAuthHeaders() });
      if (!res.ok) return;

      const tasks = await res.json();
      for (const task of tasks) {
        await this.processTask(task);
      }
    } catch (err) {
      // Silently handle poll disconnect
    }
  }

  async fetchTemplateForTask(model, fileType, templateId = null) {
    try {
      const res = await fetch(`${this.serverUrl}/api/templates`, { headers: this.workerAuthHeaders() });
      if (res.ok) {
        const tmpls = await res.json();
        // Priority 1: Match by exact templateId if provided
        let found = templateId ? tmpls.find(t => t.id === templateId) : null;
        // Priority 2: Match by exact model and type
        if (!found) {
          found = tmpls.find(t => (t.model === model || t.model.toUpperCase() === model.toUpperCase()) && t.type === fileType);
        }
        // Priority 3: Match by normalized model substring (e.g. 'POA3500' <-> '3500')
        if (!found) {
          const cleanModel = String(model).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
          found = tmpls.find(t => {
            const cleanTmpl = String(t.model).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
            return (cleanTmpl === cleanModel || cleanModel.includes(cleanTmpl) || cleanTmpl.includes(cleanModel)) && t.type === fileType;
          });
        }
        if (found) {
          if (found.filepath && fs.existsSync(found.filepath)) {
            return found;
          }
          try {
            const cacheDir = path.join(this.workingDir, 'cached_templates');
            if (!fs.existsSync(cacheDir)) {
              fs.mkdirSync(cacheDir, { recursive: true });
            }
            const localTmplPath = path.join(cacheDir, `${found.id}_${found.filename}`);
            const dlRes = await fetch(`${this.serverUrl}/api/templates/${found.id}/download`, { headers: this.workerAuthHeaders() });
            if (dlRes.ok) {
              const buffer = Buffer.from(await dlRes.arrayBuffer());
              fs.writeFileSync(localTmplPath, buffer);
              return {
                ...found,
                filepath: localTmplPath
              };
            }
          } catch (dlErr) {
            console.warn('[Worker Template Download Warning]', dlErr.message);
          }
        }
      }
    } catch (e) {
      console.warn('[Worker fetchTemplateForTask error]', e.message);
    }

    const samplesDir = path.resolve(__dirname, '../../samples');
    let fallbackPath = '';
    if (fileType === 'cert') {
      if (model === '990' || model === 'DPT-990-Ex' || model === '990-Ex') {
        fallbackPath = path.join(samplesDir, '990-Ex-EX10260902发货证书.doc');
      } else if (model === 'DPT810') {
        fallbackPath = path.join(samplesDir, 'DPT810证书(变送器-A010007031)-JM-26.8.28.doc');
      } else {
        fallbackPath = path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');
      }
    } else if (fileType === 'packing') {
      if (model === 'POA200') {
        fallbackPath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
      } else if (model === '990' || model === 'DPT-990-Ex' || model === '990-Ex') {
        fallbackPath = path.join(samplesDir, '990-Ex-EX10260902装箱清单.doc');
      } else {
        fallbackPath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
      }
    }
    return { filepath: fallbackPath, field_mappings: {} };
  }

  async processTask(task) {
    console.log(`[${this.name}] 正在处理发货任务 #${task.id} (${task.model} ${task.device_sn})`);

    const formData = { model: task.model, deviceSn: task.device_sn, ...(task.form_data || {}) };
    const files = task.files || [];

    for (const fileRec of files) {
      try {
        const tmplObj = await this.fetchTemplateForTask(task.model, fileRec.file_type, fileRec.template_id);
        const templatePath = tmplObj.filepath;
        const fieldMappings = (fileRec.field_mappings && Object.keys(fileRec.field_mappings).length > 0)
          ? fileRec.field_mappings
          : (tmplObj.field_mappings || {});

        if (!templatePath || !fs.existsSync(templatePath)) {
          throw new Error(`Template path not found for model ${task.model} (${fileRec.file_type})`);
        }

        const officialFilename = fileRec.official_filename;

        // WC-21: 目标目录缺失时明确拒绝，严禁回退 workingDir！
        if (!fileRec.target_dir || !fileRec.target_dir.trim()) {
          throw new Error('任务未指定有效保存目标目录，拒绝执行 (WC-21)');
        }

        const targetDir = fileRec.target_dir;
        const rootDir = fileRec.root_dir || fileRec.target_dir;

        // WC-20 / 4.2 / 6.5: 执行前校验当前有效授权（撤销写权限后不得依据旧授权继续写入）
        const authInfo = await this.ensureWriteAuthorized(targetDir, rootDir);

        // Pre-save directory check: ensure target directory exists and is writable (DIR-16)
        if (!fs.existsSync(targetDir)) {
          try {
            fs.mkdirSync(targetDir, { recursive: true });
          } catch (mErr) {
            throw new Error(`目标目录创建失败 [${targetDir}]: ${mErr.message} (DIR-16)`);
          }
        }

        // 创建后再确认一次实际落点没有通过联接跳出授权根目录 (6.7)
        if (!isSubpath(authInfo.authorizedRoot, safeRealPath(targetDir))) {
          throw new Error(`安全拦截：目标目录 [${targetDir}] 经解析后超出授权业务路径 [${authInfo.authorizedRoot}]！(6.7)`);
        }

        // Writability check on targetDir
        const probeFile = path.join(targetDir, `.write_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
        try {
          fs.writeFileSync(probeFile, 'probe');
          fs.unlinkSync(probeFile);
        } catch (wErr) {
          throw new Error(`保存失败：目标目录不可写或磁盘已断开 [${targetDir}] (${wErr.message}) (DIR-16)`);
        }

        const { officialFilePath } = handleFileConflictAndOverwrite(
          targetDir,
          officialFilename,
          formData.overwriteConfirmed
        );

        // Pass fieldMappings to generateWordDocument so doc_processor uses confirmed mappings (Spec Sec 8)
        const genResult = generateWordDocument(templatePath, officialFilePath, {
          type: fileRec.file_type,
          formData,
          fieldMappings,
          field_mappings: fieldMappings,
          certTemplate: { field_mappings: fieldMappings },
          tableConfig: fieldMappings?.tableConfig || null
        });

        await this.uploadReturnedFile(task.id, fileRec.file_type, officialFilename, officialFilePath, genResult.sha256);

      } catch (err) {
        console.error(`Task #${task.id} file ${fileRec.file_type} failed:`, err.message);
        await this.reportFileFailed(task.id, fileRec.file_type, err.message);
      }
    }
  }

  async reportFileFailed(taskId, fileType, errorMsg) {
    try {
      await fetch(`${this.serverUrl}/api/worker/tasks/${taskId}/file-failed`, {
        method: 'POST',
        headers: this.workerHeaders(),
        body: JSON.stringify({ fileType, errorMsg })
      });
    } catch (e) {}
  }

  async uploadReturnedFile(taskId, fileType, officialFilename, filePath, sha256) {
    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'application/msword' });

    formData.append('fileType', fileType);
    formData.append('officialFilename', officialFilename);
    formData.append('sha256', sha256 || getFileSha256(filePath));
    formData.append('workerFilePath', filePath);
    formData.append('wordFile', blob, officialFilename);

    const res = await fetch(`${this.serverUrl}/api/worker/tasks/${taskId}/file-returned`, {
      method: 'POST',
      headers: this.workerAuthHeaders(),
      body: formData
    });

    return await res.json();
  }

  async pollAndExecutePrintJobs() {
    try {
      const res = await fetch(`${this.serverUrl}/api/print/pending?workerId=${encodeURIComponent(this.workerId)}`, { headers: this.workerAuthHeaders() });
      if (!res.ok) return;

      const jobs = await res.json();
      for (const job of jobs) {
        await this.processPrintJob(job);
      }
    } catch (err) {
      // Silently handle
    }
  }

  /**
   * 解析打印任务里每个文件项在“本执行端”的真实路径。
   * 不使用猜测的 print_job_编号 文件名（PR-B04）：优先任务快照里执行端自己的保存路径，
   * 其次按 task_files 记录的路径；都不存在时经协调端受控下载副本。
   */
  async resolvePrintItemPath(item) {
    const candidates = [];
    if (item.snapshotPath) candidates.push(item.snapshotPath);
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/tasks/print-item/${item.id}/file`, { headers: this.workerAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (data && data.workerFilePath) candidates.push(data.workerFilePath);
        if (data && data.serverFilePath) candidates.push(data.serverFilePath);
      }
    } catch (e) {}
    const local = candidates.find(p => p && fs.existsSync(p));
    if (local) return local;

    // 本机原件缺失：经协调端受控下载副本到本机并校验哈希（REV183-10 / §6），
    // 绝不直接打开协调端的盘符路径，也不依赖协调端反向访问本机。
    return await this.downloadTaskFileFromCoordinator(item);
  }

  /**
   * 从协调端下载本任务已回传原件到本机（授权目录内）并校验哈希。
   * 返回本机可打印的真实路径；任何一步不满足都返回 null 并说明原因。
   */
  async downloadTaskFileFromCoordinator(item) {
    if (!item || !item.taskId || !item.fileType) {
      console.error(`[打印] 打印项 ${item && item.taskFileId ? item.taskFileId : '?'} 缺少 taskId/fileType，无法下载原件副本`);
      return null;
    }
    const targetDir = path.join(this.workingDir, 'returned_copies');
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      console.error(`[打印] 无法创建本机下载目录 ${targetDir}: ${e.message}`);
      return null;
    }
    const targetName = item.officialFilename || `task${item.taskId}_${item.fileType}.doc`;
    const targetPath = path.join(targetDir, `${item.taskId}_${item.fileType}_${targetName}`);

    // 下载前确认落地目录在本机被授予的写入范围内（授权由本机主动查询协调端，不依赖反向访问）
    try {
      const auth = await this.fetchAuthorizations();
      if (auth.ok) {
        const writeRoots = (auth.allowedPaths || []).filter(ap => ap.allow_write);
        if (writeRoots.length > 0 && !writeRoots.some(ap => isSubpath(ap.root_path, targetDir))) {
          console.error(`[打印] 下载目录 ${targetDir} 不在本机授权写入范围内，拒绝下载 (WC-20)`);
          return null;
        }
      }
    } catch (e) {}

    const url = `${this.serverUrl}/api/worker/tasks/${item.taskId}/files/${item.fileType}/download`;
    try {
      const res = await fetch(url, { headers: this.workerAuthHeaders() });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j && j.error) detail = j.error; } catch (e) {}
        console.error(`[打印] 从协调端下载 ${item.fileType} 副本失败：${detail}`);
        return null;
      }
      const expectedHash = item.sha256 || res.headers.get('x-file-sha256') || '';
      const buffer = Buffer.from(await res.arrayBuffer());
      // 先落临时文件并校验哈希，通过后才改名，避免半截文件被打印
      const tmpPath = `${targetPath}.downloading`;
      fs.writeFileSync(tmpPath, buffer);
      const actualHash = getFileSha256(tmpPath);
      if (expectedHash && actualHash !== expectedHash) {
        try { fs.unlinkSync(tmpPath); } catch (e) {}
        console.error(`[打印] 下载副本哈希不一致（期望 ${String(expectedHash).slice(0, 12)}…，实际 ${String(actualHash).slice(0, 12)}…），拒绝打印`);
        return null;
      }
      fs.renameSync(tmpPath, targetPath);
      try { fs.chmodSync(targetPath, 0o666); } catch (e) {}
      console.log(`[打印] 已从协调端下载 ${item.fileType} 副本到本机: ${targetPath}（哈希校验通过）`);
      return targetPath;
    } catch (e) {
      console.error(`[打印] 下载 ${item.fileType} 副本异常: ${e.message}`);
      return null;
    }
  }

  /** 调用打印脚本；返回 { success, engine, windowsJobIds, error, stage } */
  invokePrintCommand(filePath, printerName, copies) {
    const script = path.join(__dirname, 'print_document.ps1');
    if (!fs.existsSync(script)) {
      return { success: false, stage: 'engine-missing', error: `缺少打印脚本 ${script}` };
    }
    let stdout = '';
    try {
      stdout = execSync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -FilePath "${filePath}" -PrinterName "${printerName}" -Copies ${Number(copies) || 1}`,
        { encoding: 'utf-8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      const detail = String((err && (err.stdout || err.stderr || err.message)) || '').trim();
      return { success: false, stage: 'command-failed', error: detail.slice(0, 500) || '打印命令执行失败' };
    }
    const line = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
    try {
      const parsed = JSON.parse(line);
      return {
        success: !!parsed.success,
        stage: parsed.stage || 'unknown',
        engine: parsed.engine || null,
        windowsJobIds: Array.isArray(parsed.windowsJobIds) ? parsed.windowsJobIds : [],
        error: parsed.error || null
      };
    } catch (e) {
      return { success: false, stage: 'bad-output', error: `打印脚本输出无法解析: ${line.slice(0, 300)}` };
    }
  }

  async reportPrintItemStatus(jobId, item, status, extra = {}) {
    try {
      await fetch(`${this.serverUrl}/api/print/${jobId}/status`, {
        method: 'POST',
        headers: this.workerHeaders(),
        body: JSON.stringify({
          status,
          fileId: item.taskFileId,
          fileType: item.fileType,
          errorMsg: extra.errorMsg || null,
          windowsJobId: extra.windowsJobId || null,
          printerName: extra.printerName || null
        })
      });
    } catch (e) {
      console.error(`[打印] 任务 #${jobId} ${item.fileType} 状态回报失败:`, e.message);
    }
  }

  async processPrintJob(job) {
    const printerName = job.printer_name;
    console.log(`[${this.name}] 正在处理打印任务 #${job.id}，目标打印机: ${printerName}`);

    if (!isPrinterAllowed(printerName, this.allowedPrinters)) {
      const reason = `打印机 '${printerName}' 未在执行端白名单中或未连接`;
      console.warn(`Print rejected: ${reason}`);
      for (const item of (job.items || [])) {
        await this.reportPrintItemStatus(job.id, item, 'FAILED', { errorMsg: reason, printerName });
      }
      return;
    }

    const items = Array.isArray(job.items) && job.items.length > 0
      ? job.items
      : (job.batch_items || []).map((b, i) => ({ id: null, taskFileId: b.fileId, fileType: b.fileType, copies: b.copies }));

    for (const item of items) {
      // 文件级结果独立记录：确定单项失败且只是该文件错误时可继续下一项 (PR13)
      await this.reportPrintItemStatus(job.id, item, 'DISPATCHING', { printerName });

      const filePath = await this.resolvePrintItemPath(item);
      if (!filePath) {
        await this.reportPrintItemStatus(job.id, item, 'FAILED', {
          errorMsg: `未找到该任务实际生成的文件（不按猜测文件名查找）(fileType=${item.fileType})`,
          printerName
        });
        continue;
      }

      // 版本校验：打印的必须是受理时确认的那一版内容 (PR14)
      if (item.sha256) {
        const actual = getFileSha256(filePath);
        if (actual !== item.sha256) {
          await this.reportPrintItemStatus(job.id, item, 'FAILED', {
            errorMsg: `文件内容与受理时版本不一致（受理哈希 ${String(item.sha256).slice(0, 12)}…，当前 ${String(actual || '').slice(0, 12)}…），已拒绝打印以防打印到别的版本`,
            printerName
          });
          continue;
        }
      }

      // 授权目录复核（4.2 / WC-20）
      try {
        const dir = path.dirname(filePath);
        await this.ensureWriteAuthorized(dir, dir);
      } catch (authErr) {
        await this.reportPrintItemStatus(job.id, item, 'FAILED', { errorMsg: authErr.message, printerName });
        continue;
      }

      const result = this.invokePrintCommand(filePath, printerName, item.copies || 1);
      if (result.success) {
        const jobId = (result.windowsJobIds && result.windowsJobIds[0]) || null;
        await this.reportPrintItemStatus(job.id, item, 'SUBMITTED_TO_SPOOLER', {
          printerName,
          windowsJobId: jobId,
          errorMsg: jobId ? null : '已调用打印能力，但未能取得 Windows 队列作业号，无法确认是否已进入队列'
        });
        console.log(`[打印] 任务 #${job.id} ${item.fileType} 已提交打印队列 (engine=${result.engine || '-'}, windowsJob=${jobId || '未取得'})`);
      } else {
        // 已调用但结果无法确认 → RESULT_UNKNOWN（不得自动重印）；明确失败 → FAILED
        const status = result.stage === 'command-failed' || result.stage === 'bad-output' ? 'RESULT_UNKNOWN' : 'FAILED';
        await this.reportPrintItemStatus(job.id, item, status, {
          printerName,
          errorMsg: `打印失败（阶段: ${result.stage}）: ${result.error || '未知原因'}`
        });
        console.error(`[打印] 任务 #${job.id} ${item.fileType} 失败(${status}): ${result.error}`);
      }
    }
  }
}

if (require.main === module) {
  const worker = new ExecutionWorker();

  const physicalPrinters = worker.allowedPrinters.filter(p => 
    !p.toLowerCase().includes('pdf') && 
    !p.toLowerCase().includes('onenote') && 
    !p.includes('导出')
  );
  const virtualPrinters = worker.allowedPrinters.filter(p => 
    p.toLowerCase().includes('pdf') || 
    p.toLowerCase().includes('onenote') || 
    p.includes('导出')
  );

  console.log('====================================================');
  console.log(`执行端程序启动成功: ${worker.name}`);
  console.log('====================================================');
  console.log(`- 执行端 ID: ${worker.workerId}（来源: ${worker.configSources.workerId}）`);
  console.log(`- 协调服务地址: ${worker.serverUrl}（来源: ${worker.configSources.server}）`);
  console.log(`- 接入凭据: ${worker.workerSecret ? '已保存在本机配置文件（不显示内容）' : '缺失'}`);
  console.log(`- 本地工作目录: ${worker.workingDir}`);
  console.log('- 监听端口: 无（执行端只主动连接协调服务，本机不开放任何入站端口）');

  if (physicalPrinters.length > 0) {
    console.log(`- 物理/共享打印机: ${physicalPrinters.join(', ')}`);
  } else {
    console.log(`- 物理/共享打印机: 未连接 / 未配置`);
  }

  if (virtualPrinters.length > 0) {
    console.log(`- 系统虚拟打印: ${virtualPrinters.join(', ')}`);
  }

  // 连接地址引导：远程执行端绝不能停在“连自己”的回环地址上（MW-B01 / 183 部署文档 §3.1）
  const isLoopback = /127\.0\.0\.1|localhost|\[::1\]/i.test(worker.serverUrl);
  if (isLoopback && !worker.savedOnThisMachine) {
    console.log('----------------------------------------------------');
    console.log('⚠ 当前连接目标是本机回环地址，且尚未在本机保存过协调地址。');
    console.log('  如果这台电脑不是协调服务所在电脑，请先指定协调电脑的局域网地址（只需设置一次，之后自动沿用）：');
    console.log('    双击  配置执行端接入.bat        或');
    console.log('    node src/worker/worker.js --server http://<协调电脑IP>:3001');
    console.log('  （地址会保存到 worker_config.local.json，以后启动不需要再输入）');
  }
  console.log('----------------------------------------------------');
  console.log('提示：本机连接地址、身份与接入凭据保存在 worker_config.local.json，请勿复制到其他电脑；');
  console.log('      模板启用、授权路径与保存目录仍由协调服务集中配置，本机无需维护业务规则；');
  console.log('      文件生成与打印均在本机完成，不需要协调端反向访问本机。');
  console.log('----------------------------------------------------');

  worker.sendHeartbeat();
  worker.pollAndExecuteTasks();
  worker.pollAndExecutePrintJobs();

  setInterval(() => {
    worker.sendHeartbeat();
    worker.pollAndExecuteTasks();
    worker.pollAndExecutePrintJobs();
  }, 1000);
}

module.exports = ExecutionWorker;
module.exports.ExecutionWorker = ExecutionWorker;
module.exports.WorkerClient = ExecutionWorker;
module.exports.firewallHint = firewallHint;
