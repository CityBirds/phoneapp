const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { generateWordDocument } = require('./word_engine');
const { isPathInWhitelist, isPrinterAllowed } = require('./security');
const { handleFileConflictAndOverwrite } = require('./conflict');
const { getFileSha256 } = require('../common/utils');

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

/**
 * Parse Command Line Arguments
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) {
      options.workerId = args[i + 1];
      i++;
    } else if (args[i] === '--name' && args[i + 1]) {
      options.name = args[i + 1];
      i++;
    } else if (args[i] === '--server' && args[i + 1]) {
      options.serverUrl = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      options.serverUrl = `http://localhost:${args[i + 1]}`;
      i++;
    } else if (args[i] === '--dir' && args[i + 1]) {
      options.workingDir = args[i + 1];
      i++;
    }
  }
  return options;
}

// Helper: Check path containment strictly without prefix bug (DIR-13, WC-08)
function isSubpath(parent, child) {
  if (!parent || !child) return false;
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);
  const pLower = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  const cLower = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  if (pLower === cLower) return true;
  const rel = path.relative(normParent, normChild);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

class ExecutionWorker {
  constructor(config = {}) {
    const cliOptions = parseCliArgs();
    this.workerId = config.workerId || cliOptions.workerId || 'worker-local';
    this.name = config.name || cliOptions.name || `执行终端 (${this.workerId})`;
    this.serverUrl = config.serverUrl || cliOptions.serverUrl || 'http://localhost:3000';
    this.workingDir = config.workingDir || cliOptions.workingDir || path.resolve(__dirname, `../../data/working_dir_${this.workerId}`);

    // Read worker_config.json if present
    const configPath = path.resolve(__dirname, '../../worker_config.json');
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch (e) {}
    }

    if (config.allowedPrinters && config.allowedPrinters.length > 0) {
      this.allowedPrinters = config.allowedPrinters;
    } else if (fileConfig.allowedPrinters && fileConfig.allowedPrinters.length > 0) {
      this.allowedPrinters = fileConfig.allowedPrinters;
    } else {
      this.allowedPrinters = getInstalledSystemPrinters();
    }

    if (!fs.existsSync(this.workingDir)) {
      fs.mkdirSync(this.workingDir, { recursive: true });
    }
  }

  async sendHeartbeat() {
    try {
      const res = await fetch(`${this.serverUrl}/api/workers/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerId: this.workerId,
          name: this.name,
          workingDir: this.workingDir,
          printers: this.allowedPrinters,
          status: 'ONLINE'
        })
      });
      const data = await res.json();
      if (!this._connected) {
        this._connected = true;
        console.log(`[成功] 已连接协调服务 (${this.serverUrl})！状态: ONLINE，终端ID: ${this.workerId}，监听任务与打印调度...`);
      }
      await this.pollAndExecuteDirectoryChecks();
      return data;
    } catch (err) {
      if (this._connected !== false) {
        this._connected = false;
        console.log(`[提示] 正在等待协调服务启动 (${this.serverUrl})...`);
      }
      return null;
    }
  }

  async fetchActiveAuthorizations() {
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/authorizations?workerId=${this.workerId}`);
      if (res.ok) {
        const data = await res.json();
        return data.allowedPaths || [];
      }
    } catch (e) {}
    return [];
  }

  async pollAndExecuteDirectoryChecks() {
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/directory-checks/pending?workerId=${this.workerId}`);
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
        // WC-08, E04: Verify rootDir is within active authorized write paths
        const activeAuths = await this.fetchActiveAuthorizations();
        if (activeAuths.length > 0) {
          const isAllowed = activeAuths.some(ap => ap.allow_write && isSubpath(ap.root_path, rootDir));
          if (!isAllowed) {
            status = 'FAILED';
            message = `保存目录未在允许访问的业务路径范围内 (E04, WC-08)`;
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

    if (status === 'PASSED') {
      const probeFile = path.join(rootDir, `.write_probe_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
      try {
        fs.writeFileSync(probeFile, 'probe');
        const readBack = fs.readFileSync(probeFile, 'utf-8');
        if (readBack !== 'probe') throw new Error('探测文件校验失败');
        fs.unlinkSync(probeFile);
      } catch (err) {
        try { if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile); } catch (e) {}
        status = 'FAILED';
        message = `目录不可写或权限不足: ${err.message} (DIR-11)`;
      }
    }

    try {
      await fetch(`${this.serverUrl}/api/worker/directory-checks/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkId: check.id,
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
      const res = await fetch(`${this.serverUrl}/api/worker/tasks/pending?workerId=${this.workerId}`);
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
      const res = await fetch(`${this.serverUrl}/api/templates`);
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
            const dlRes = await fetch(`${this.serverUrl}/api/templates/${found.id}/download`);
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

        // Security boundary check: ensure targetDir does not escape rootDir (DIR-13, WC-08)
        if (!isSubpath(rootDir, targetDir)) {
          throw new Error(`安全拦截：目标保存路径 [${targetDir}] 试图跳出指定根目录范围 [${rootDir}]！(DIR-13, WC-08)`);
        }

        // WC-20: 检查当前有效授权写入范围，若授权已撤销或无效则拒绝执行
        const activeAuths = await this.fetchActiveAuthorizations();
        if (activeAuths && activeAuths.length > 0) {
          const isAuthorized = activeAuths.some(ap => ap.allow_write && isSubpath(ap.root_path, targetDir));
          if (!isAuthorized) {
            throw new Error(`任务保存目标目录已不在执行端当前授权范围内（授权已撤销或失效），拒绝执行写入 (WC-20)`);
          }
        }

        // Pre-save directory check: ensure target directory exists and is writable (DIR-16)
        if (!fs.existsSync(targetDir)) {
          try {
            fs.mkdirSync(targetDir, { recursive: true });
          } catch (mErr) {
            throw new Error(`目标目录创建失败 [${targetDir}]: ${mErr.message} (DIR-16)`);
          }
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
        headers: { 'Content-Type': 'application/json' },
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
      body: formData
    });

    return await res.json();
  }

  async pollAndExecutePrintJobs() {
    try {
      const res = await fetch(`${this.serverUrl}/api/print/pending?workerId=${this.workerId}`);
      if (!res.ok) return;

      const jobs = await res.json();
      for (const job of jobs) {
        await this.processPrintJob(job);
      }
    } catch (err) {
      // Silently handle
    }
  }

  async processPrintJob(job) {
    console.log(`[${this.name}] 正在处理打印任务 #${job.id}，目标打印机: ${job.printer_name}`);

    if (!isPrinterAllowed(job.printer_name, this.allowedPrinters)) {
      console.warn(`Print rejected: ${job.printer_name} not in allowed whitelist`);
      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FAILED', errorMsg: `打印机 '${job.printer_name}' 未在执行端白名单中或未连接` })
      });
      return;
    }

    await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'SUBMITTED_TO_QUEUE' })
    });

    try {
      if (process.platform === 'win32') {
        const batchItems = job.batch_items || [];
        for (const item of batchItems) {
          const copies = item.copies || 1;
          const targetTaskFile = path.join(this.workingDir, `print_job_${job.id}_${item.fileType}.doc`);
          if (fs.existsSync(targetTaskFile)) {
            for (let c = 0; c < copies; c++) {
              try {
                execSync(`powershell -NoProfile -Command "Start-Process -FilePath '${targetTaskFile}' -Verb PrintTo -ArgumentList '${job.printer_name}'"`, {
                  timeout: 10000,
                  stdio: 'ignore'
                });
              } catch (e) {}
            }
          }
        }
      }

      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PRINTED' })
      });
      console.log(`Print Job #${job.id} dispatched to physical printer queue.`);
    } catch (err) {
      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FAILED', errorMsg: err.message })
      });
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
  console.log(`- 执行端 ID: ${worker.workerId}`);
  console.log(`- 协调服务地址: ${worker.serverUrl}`);
  console.log(`- 本地工作目录: ${worker.workingDir}`);
  
  if (physicalPrinters.length > 0) {
    console.log(`- 物理/共享打印机: ${physicalPrinters.join(', ')}`);
  } else {
    console.log(`- 物理/共享打印机: 未连接 / 未配置`);
  }

  if (virtualPrinters.length > 0) {
    console.log(`- 系统虚拟打印: ${virtualPrinters.join(', ')}`);
  }
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

ExecutionWorker.ExecutionWorker = ExecutionWorker;
ExecutionWorker.WorkerClient = ExecutionWorker;
module.exports = ExecutionWorker;
