const { generateDocumentPreview, isValidPdf, getPreviewPdfPath, getPreviewPageDir, clearDocumentPreview } = require('./preview');
const db = require('./db');

class PreviewQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 1;
    this.queue = [];
    this.activeCount = 0;
    this.activeJobs = new Map(); // key: `${taskId}_${fileType}`, value: job
    this.onTaskStatusChanged = options.onTaskStatusChanged || (() => {});
  }

  enqueue(params) {
    const { taskId, fileType, sourcePath, previewDir, forceStage } = params;
    const key = `${taskId}_${fileType}`;

    if (this.activeJobs.has(key)) {
      return { status: 'ALREADY_ACTIVE' };
    }

    const existingInQueue = this.queue.find(j => j.key === key);
    if (existingInQueue) {
      return { status: 'ALREADY_QUEUED' };
    }

    const job = {
      key,
      taskId,
      fileType,
      sourcePath,
      previewDir,
      forceStage,
      queuedAt: Date.now()
    };

    this.queue.push(job);
    this.updateTaskFileStatus(taskId, fileType, 'QUEUED', '排队等待转换预览...');
    this.processNext();
    return { status: 'QUEUED' };
  }

  processNext() {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    const { key, taskId, fileType, sourcePath, previewDir, forceStage } = job;

    this.activeCount++;
    this.activeJobs.set(key, job);
    job.startedAt = Date.now();

    this.updateTaskFileStatus(taskId, fileType, forceStage === 'images' ? 'CONVERTING_IMAGE' : 'CONVERTING_PDF', '正在转换预览...');

    setImmediate(async () => {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          job.timeoutTimer = setTimeout(() => {
            reject(new Error('预览转换超时（超过最大处理时长限制）'));
          }, 300000);
        });

        const conversionPromise = Promise.resolve().then(() => {
          return generateDocumentPreview({
            sourcePath,
            previewDir,
            taskId,
            fileType,
            forceStage
          });
        });

        const previewPayload = await Promise.race([conversionPromise, timeoutPromise]);
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

        this.updateTaskFileSuccess(taskId, fileType, previewPayload);
      } catch (err) {
        if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
        console.error(`[PreviewQueue] Task ${taskId} ${fileType} 转换失败:`, err.message);
        const isTimeout = err.message.includes('超时');
        const finalStatus = isTimeout ? 'PREVIEW_TIMEOUT' : 'PREVIEW_FAILED';
        this.updateTaskFileError(taskId, fileType, finalStatus, err.message);
      } finally {
        this.activeCount--;
        this.activeJobs.delete(key);
        try { this.onTaskStatusChanged(taskId); } catch (e) {}
        this.processNext();
      }
    });
  }

  updateTaskFileStatus(taskId, fileType, status, msg) {
    try {
      db.prepare(`
        UPDATE task_files
        SET status = ?, error_msg = ?
        WHERE task_id = ? AND file_type = ?
      `).run(status, msg, taskId, fileType);
      try { this.onTaskStatusChanged(taskId); } catch (e) {}
    } catch (e) {
      console.error('[PreviewQueue DB Error]', e.message);
    }
  }

  updateTaskFileSuccess(taskId, fileType, payload) {
    try {
      const pageUrlsJson = JSON.stringify(payload.pageUrls || []);
      db.prepare(`
        UPDATE task_files
        SET preview_images = ?, status = 'PREVIEW_READY', error_msg = NULL
        WHERE task_id = ? AND file_type = ?
      `).run(pageUrlsJson, taskId, fileType);
      try { this.onTaskStatusChanged(taskId); } catch (e) {}
    } catch (e) {
      console.error('[PreviewQueue DB Error]', e.message);
    }
  }

  updateTaskFileError(taskId, fileType, status, errorMsg) {
    try {
      db.prepare(`
        UPDATE task_files
        SET status = ?, error_msg = ?, preview_images = '[]'
        WHERE task_id = ? AND file_type = ?
      `).run(status, errorMsg, taskId, fileType);
      try { this.onTaskStatusChanged(taskId); } catch (e) {}
    } catch (e) {
      console.error('[PreviewQueue DB Error]', e.message);
    }
  }
}

module.exports = PreviewQueue;
