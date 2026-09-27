const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { isPathInWhitelist, isPrinterAllowed } = require('./security');
const { handleFileConflictAndOverwrite } = require('./conflict');
const { generateWordDocument } = require('./word_engine');
const { getFileSha256 } = require('../common/utils');

function getInstalledSystemPrinters() {
  if (process.platform === 'win32') {
    try {
      const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Printer | Select-Object Name | ConvertTo-Json`;
      const out = execSync(`powershell.exe -NoProfile -Command "${script}"`, { encoding: 'utf-8', timeout: 5000 });
      const data = JSON.parse(out);
      const list = Array.isArray(data) ? data : [data];
      return list.map(p => p.Name).filter(Boolean);
    } catch (e) {
      try {
        const out = execSync('wmic printer get name', { encoding: 'utf-8', timeout: 5000 });
        return out.split(/\r?\n/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'name');
      } catch (err) {
        return [];
      }
    }
  }
  return [];
}

class ExecutionWorker {
  constructor(config = {}) {
    this.workerId = config.workerId || 'worker-local';
    this.name = config.name || 'Execution Worker (PC-01)';
    this.serverUrl = config.serverUrl || 'http://localhost:3000';
    this.workingDir = config.workingDir || path.resolve(__dirname, '../../data/working_dir');

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
      // Dynamic detection of real printers installed on system
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
        console.log(`[成功] 已连接协调服务 (${this.serverUrl})！状态: ONLINE，正在监听任务与打印调度...`);
      }
      return data;
    } catch (err) {
      if (this._connected !== false) {
        this._connected = false;
        console.log(`[提示] 正在等待协调服务启动 (${this.serverUrl})...`);
        console.log(`       请确保在另一窗口运行: node src/backend/server.js`);
      }
      return null;
    }
  }

  async pollAndExecuteTasks() {
    try {
      const res = await fetch(`${this.serverUrl}/api/worker/tasks/pending?workerId=${this.workerId}`);
      if (!res.ok) return;

      const tasks = await res.json();
      for (const task of tasks) {
        await this.processTask(task);
      }
    } catch (err) {
      console.warn('Task polling error:', err.message);
    }
  }

  async processTask(task) {
    console.log(`Processing Task #${task.id} (${task.model} ${task.device_sn})`);

    const formData = task.form_data || {};
    const files = task.files || [];

    for (const fileRec of files) {
      try {
        const samplesDir = path.resolve(__dirname, '../../samples');
        let templatePath = '';
        if (fileRec.file_type === 'cert') {
          templatePath = task.model === 'DPT810'
            ? path.join(samplesDir, 'DPT810证书(变送器-A010007031)-JM-26.8.28.doc')
            : path.join(samplesDir, 'POA200证书AP10007513-20260403发南京订单-PSR-12-223(封装）带泵.doc');
        } else {
          templatePath = path.join(samplesDir, 'POA200(140)AP10007513发货清单20260403带泵.doc');
        }

        const officialFilename = fileRec.official_filename;

        const { officialFilePath } = handleFileConflictAndOverwrite(
          this.workingDir,
          officialFilename,
          formData.overwriteConfirmed
        );

        if (!isPathInWhitelist(officialFilePath, this.workingDir)) {
          throw new Error(`Security Violation: Target path outside working directory boundary! (E02)`);
        }

        const genResult = generateWordDocument(templatePath, officialFilePath, {
          type: fileRec.file_type,
          formData
        });

        await this.uploadReturnedFile(task.id, fileRec.file_type, officialFilename, officialFilePath, genResult.sha256);

      } catch (err) {
        console.error(`Task #${task.id} file ${fileRec.file_type} failed:`, err.message);
      }
    }
  }

  async uploadReturnedFile(taskId, fileType, officialFilename, filePath, sha256) {
    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'application/msword' });

    formData.append('wordFile', blob, officialFilename);
    formData.append('fileType', fileType);
    formData.append('officialFilename', officialFilename);
    formData.append('sha256', sha256 || getFileSha256(filePath));

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
      console.warn('Print job polling error:', err.message);
    }
  }

  async processPrintJob(job) {
    console.log(`Processing Print Job #${job.id} on printer: ${job.printer_name}`);

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

    setTimeout(async () => {
      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PRINTED' })
      });
      console.log(`Print Job #${job.id} marked as PRINTED.`);
    }, 1000);
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
  console.log(`- 工作目录: ${worker.workingDir}`);
  
  if (physicalPrinters.length > 0) {
    console.log(`- 物理打印机: ${physicalPrinters.join(', ')}`);
  } else {
    console.log(`- 物理打印机: 未连接 / 未配置`);
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
  }, 3000);
}

module.exports = ExecutionWorker;
