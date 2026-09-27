const path = require('path');
const fs = require('fs');
const { isPathInWhitelist, isPrinterAllowed } = require('./security');
const { handleFileConflictAndOverwrite } = require('./conflict');
const { generateWordDocument } = require('./word_engine');
const { getFileSha256 } = require('../common/utils');

class ExecutionWorker {
  constructor(config = {}) {
    this.workerId = config.workerId || 'worker-local';
    this.name = config.name || 'Execution Worker (PC-01)';
    this.serverUrl = config.serverUrl || 'http://localhost:3000';
    this.workingDir = config.workingDir || path.resolve(__dirname, '../../data/working_dir');
    this.allowedPrinters = config.allowedPrinters || ['Epson EcoTank L3258', 'Microsoft Print to PDF'];

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
      return await res.json();
    } catch (err) {
      console.warn('Worker heartbeat failed:', err.message);
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
        // Find template file
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

        // E07, R18-R20: Handle file overwrite & conflict protection
        const { officialFilePath, renamedCopyPath } = handleFileConflictAndOverwrite(
          this.workingDir,
          officialFilename,
          formData.overwriteConfirmed
        );

        // Security check: ensure path is inside working directory whitelist (E02, R03)
        if (!isPathInWhitelist(officialFilePath, this.workingDir)) {
          throw new Error(`Security Violation: Target path outside working directory boundary! (E02)`);
        }

        // Generate document
        const genResult = generateWordDocument(templatePath, officialFilePath, {
          type: fileRec.file_type,
          formData
        });

        // Upload returned document back to Coordination Service (E08, R21)
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
    console.log(`Processing Print Job #${job.id} on printer ${job.printer_name}`);

    // Validate printer whitelist (E02, R03)
    if (!isPrinterAllowed(job.printer_name, this.allowedPrinters)) {
      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'FAILED', errorMsg: 'Printer not in allowed whitelist' })
      });
      return;
    }

    // Report SUBMITTED_TO_QUEUE status (R27)
    await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'SUBMITTED_TO_QUEUE' })
    });

    // Simulate/Execute Windows Print Submission
    setTimeout(async () => {
      await fetch(`${this.serverUrl}/api/print/${job.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'PRINTED' })
      });
    }, 1000);
  }
}

if (require.main === module) {
  const worker = new ExecutionWorker();
  setInterval(() => {
    worker.sendHeartbeat();
    worker.pollAndExecuteTasks();
    worker.pollAndExecutePrintJobs();
  }, 3000);
}

module.exports = ExecutionWorker;
