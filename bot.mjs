import 'dotenv/config';

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';

import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import sharp from 'sharp';
import {
  removeWatermarkFromBuffer,
} from '@pilio/gemini-watermark-remover/node';
import {
  removeVideoWatermarkFromFile,
  inferVideoMimeTypeFromPath,
} from '@pilio/gemini-watermark-remover/video';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = path.resolve(process.env.TEMP_DIR || path.join(ROOT, 'tmp'));
const TOKEN = process.env.BOT_TOKEN;
const MAX_INPUT_BYTES = Number(process.env.MAX_INPUT_MB || 20) * 1024 * 1024;
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_MB || 49) * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 3600) * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 20);
const VIDEO_TIMEOUT_MS = Number(process.env.VIDEO_TIMEOUT_MS || 600000);
const VIDEO_BITRATE = Number(process.env.VIDEO_BITRATE || 12000000);
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

if (!TOKEN) throw new Error('BOT_TOKEN is required. Copy .env.example to .env and set it.');

const bot = new Bot(TOKEN);
const queue = [];
let workerRunning = false;
const userUsage = new Map();
const activeStatusTimers = new Map();

function log(level, message, extra = {}) {
  if (LOG_LEVEL === 'silent') return;
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  if ((levels[level] ?? 2) > (levels[LOG_LEVEL] ?? 2)) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...extra }));
}

function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function isAllowed(userId) {
  const now = Date.now();
  const existing = userUsage.get(userId) || [];
  const fresh = existing.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    userUsage.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  userUsage.set(userId, fresh);
  return true;
}

function enqueue(job) {
  if (queue.length >= MAX_QUEUE_SIZE) return false;
  queue.push(job);
  void runWorker();
  return true;
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try { await processJob(job); }
      catch (error) {
        log('error', 'Job failed', { userId: job.userId, error: error?.stack || String(error) });
        const message = error?.message === 'FILE_TOO_LARGE'
          ? `❌ फ़ाइल बहुत बड़ी है। Input सीमा ${humanBytes(MAX_INPUT_BYTES)} है।`
          : error?.message === 'OUTPUT_TOO_LARGE'
            ? '❌ Output बहुत बड़ा है। छोटी या कम-resolution फ़ाइल आज़माएँ।'
            : '❌ Processing failed. कृपया फ़ाइल दोबारा भेजें या छोटी फ़ाइल आज़माएँ।';
        await safeEdit(job.chatId, job.statusMessageId, message);
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function safeEdit(chatId, messageId, text) {
  try { await bot.api.editMessageText(chatId, messageId, text); } catch (error) {
    if (!String(error?.description || error).includes('message is not modified')) log('debug', 'Status edit skipped', { error: String(error) });
  }
}

function startStatusUpdates(job, label) {
  let lastText = '';
  const update = async (text) => {
    if (text === lastText) return;
    lastText = text;
    await safeEdit(job.chatId, job.statusMessageId, text);
  };
  const timer = setInterval(() => void update(`⏳ Processing ${label}...`), 5000);
  activeStatusTimers.set(job.id, timer);
  return { update, stop: () => { clearInterval(timer); activeStatusTimers.delete(job.id); } };
}

async function downloadTelegramFile(fileId, destination) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram did not return a file path');
  const response = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_INPUT_BYTES) throw new Error('FILE_TOO_LARGE');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) throw new Error('FILE_TOO_LARGE');
    chunks.push(chunk);
  }
  await writeFile(destination, Buffer.concat(chunks));
  return { size: total, filePath: file.file_path };
}

async function decodeImageData(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height, colorSpace: 'srgb' };
}

async function encodeImageData(imageData, { mimeType = 'image/png' } = {}) {
  const image = sharp(Buffer.from(imageData.data), { raw: { width: imageData.width, height: imageData.height, channels: 4 } });
  if (mimeType === 'image/jpeg') return image.jpeg({ quality: 95, mozjpeg: true }).toBuffer();
  if (mimeType === 'image/webp') return image.webp({ quality: 95 }).toBuffer();
  return image.png({ compressionLevel: 6 }).toBuffer();
}

function imageMimeFromName(name = '') {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function processJob(job) {
  const jobDir = path.join(TEMP_ROOT, job.id);
  await mkdir(jobDir, { recursive: true });
  const inputPath = path.join(jobDir, `input${job.extension}`);
  const outputPath = path.join(jobDir, `output${job.isVideo ? '.mp4' : '.png'}`);
  const status = startStatusUpdates(job, job.isVideo ? 'video' : 'image');
  try {
    await status.update(`⬇️ Downloading ${job.isVideo ? 'video' : 'photo'}...`);
    const downloaded = await downloadTelegramFile(job.fileId, inputPath);
    log('info', 'Downloaded media', { userId: job.userId, size: downloaded.size, type: job.isVideo ? 'video' : 'image' });
    await status.update(`⚙️ Processing ${job.isVideo ? 'video' : 'photo'}...`);

    let output;
    if (job.isVideo) {
      output = await removeVideoWatermarkFromFile(inputPath, {
        outputPath,
        mimeType: inferVideoMimeTypeFromPath(inputPath),
        timeoutMs: VIDEO_TIMEOUT_MS,
        videoBitrate: VIDEO_BITRATE,
        allowLowConfidence: false,
        onProgress: (progress) => {
          if (progress?.progress != null) void status.update(`⚙️ Video processing: ${Math.round(progress.progress * 100)}%`);
        },
      });
    } else {
      const input = await (await import('node:fs/promises')).readFile(inputPath);
      output = await removeWatermarkFromBuffer(input, {
        mimeType: imageMimeFromName(job.originalName),
        decodeImageData,
        encodeImageData,
        adaptiveMode: 'auto',
      });
    }

    const outputBuffer = output.buffer || await (await import('node:fs/promises')).readFile(outputPath);
    if (outputBuffer.length > MAX_OUTPUT_BYTES) throw new Error('OUTPUT_TOO_LARGE');
    await status.update('📤 Sending processed result...');
    if (job.isVideo) {
      await bot.api.sendVideo(job.chatId, new Blob([outputBuffer], { type: 'video/mp4' }), { caption: '✅ Processed video' });
    } else {
      const imageBlob = new Blob([outputBuffer], { type: imageMimeFromName(job.originalName) });
      if (outputBuffer.length <= 10 * 1024 * 1024) {
        await bot.api.sendPhoto(job.chatId, imageBlob, { caption: '✅ Processed photo' });
      } else {
        await bot.api.sendDocument(job.chatId, imageBlob, { caption: '✅ Processed photo (document)' });
      }
    }
    await safeEdit(job.chatId, job.statusMessageId, '✅ Done.');
  } finally {
    status.stop();
    await rm(jobDir, { recursive: true, force: true }).catch((error) => log('warn', 'Temp cleanup failed', { error: String(error) }));
  }
}

function helpText() {
  return `यह bot Gemini-generated photo/video process करता है।\n\n` +
    `• Photo या video भेजें\n• Processing के दौरान status message दिखेगा\n• एक समय में queue में अधिकतम ${MAX_QUEUE_SIZE} jobs\n• प्रति user ${RATE_LIMIT_MAX} files / ${Math.round(RATE_LIMIT_WINDOW_MS / 60000)} मिनट\n\n` +
    `सीमा: input अधिकतम ${humanBytes(MAX_INPUT_BYTES)}। केवल अपनी या अधिकृत सामग्री पर उपयोग करें।`;
}

bot.command('start', async (ctx) => ctx.reply(`नमस्ते ${ctx.from?.first_name || ''}!\n\n${helpText()}`));
bot.command('help', async (ctx) => ctx.reply(helpText()));

bot.on(['message:photo', 'message:video', 'message:document'], async (ctx) => {
  const message = ctx.message;
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  let fileId;
  let originalName;
  let extension;
  let isVideo;
  if (message.photo?.length) {
    fileId = message.photo.at(-1).file_id;
    originalName = 'photo.jpg'; extension = '.jpg'; isVideo = false;
  } else if (message.video) {
    fileId = message.video.file_id;
    originalName = message.video.file_name || 'video.mp4'; extension = path.extname(originalName) || '.mp4'; isVideo = true;
  } else if (message.document?.mime_type?.startsWith('video/')) {
    fileId = message.document.file_id;
    originalName = message.document.file_name || 'video.mp4'; extension = path.extname(originalName) || '.mp4'; isVideo = true;
  } else {
    return ctx.reply('कृपया केवल photo या video भेजें।');
  }

  if (!isAllowed(userId)) return ctx.reply(`⏱️ Rate limit पूरा हो गया। ${Math.ceil(RATE_LIMIT_WINDOW_MS / 60000)} मिनट बाद फिर कोशिश करें।`);
  if (queue.length >= MAX_QUEUE_SIZE) return ctx.reply('📥 Queue अभी full है। कुछ देर बाद फिर भेजें।');
  const statusMessage = await ctx.reply(`⏳ Queue में जोड़ा गया (${queue.length + 1}/${MAX_QUEUE_SIZE})...`);
  const job = { id: crypto.randomUUID(), userId, chatId, statusMessageId: statusMessage.message_id, fileId, originalName, extension, isVideo };
  if (!enqueue(job)) return safeEdit(chatId, statusMessage.message_id, '📥 Queue अभी full है।');
});

bot.catch((error) => {
  const errorValue = error.error;
  if (errorValue instanceof GrammyError) log('error', 'Telegram API error', { description: errorValue.description });
  else if (errorValue instanceof HttpError) log('error', 'Telegram network error', { error: String(errorValue) });
  else log('error', 'Unhandled bot error', { error: errorValue?.stack || String(errorValue) });
});

await mkdir(TEMP_ROOT, { recursive: true });
process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
log('info', 'Bot starting', { maxInput: humanBytes(MAX_INPUT_BYTES), queue: MAX_QUEUE_SIZE });
await bot.start({ onStart: (info) => log('info', 'Bot started', { username: info.username }) });
